import { HttpException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import {
  SpeakerSample,
  Transcription,
  TranscriptionAudio,
  TranscriptionStatus,
} from './transcription.entity';
import { FileService } from '../file/file.service';
import { PersonService } from '../person/person.service';
import { AudioProcessorService } from '../audio/audio-processor.service';
import { SonioxClientService } from '../audio/soniox-client.service';
import { PyannoteService, PyannoteSegment } from '../audio/pyannote.service';
import {
  SonioxToken,
  TranscriptMergerService,
} from '../audio/transcript-merger.service';

const PLAYBACK_URL_TTL = 6 * 60 * 60; // 6h
const TARGET_SAMPLE_DURATION = 30; // seconds
const ALLOWED_OVERLAP_SECONDS = 1.0;

export interface CreateTranscriptionInput {
  title: string;
  expectedPersonIds: number[];
  files: Array<{ path: string; originalname: string }>;
}

@Injectable()
export class TranscriptionService {
  private readonly logger = new Logger(TranscriptionService.name);

  constructor(
    @InjectRepository(Transcription)
    private readonly transcriptionRepo: Repository<Transcription>,
    @InjectRepository(TranscriptionAudio)
    private readonly audioRepo: Repository<TranscriptionAudio>,
    private readonly fileService: FileService,
    private readonly personService: PersonService,
    private readonly audioProcessor: AudioProcessorService,
    private readonly soniox: SonioxClientService,
    private readonly pyannote: PyannoteService,
    private readonly merger: TranscriptMergerService,
  ) {}

  // ---------------------------------------------------------------------------
  // Creation + listing
  // ---------------------------------------------------------------------------

  /**
   * Create a transcription from uploaded files, persist each file to S3, then
   * kick off background processing. Returns the created row immediately.
   */
  async create(input: CreateTranscriptionInput): Promise<Transcription> {
    if (!input.files || input.files.length === 0) {
      throw new HttpException('حداقل یک فایل صوتی لازم است', 400);
    }

    const transcription = await this.transcriptionRepo.save(
      this.transcriptionRepo.create({
        title: input.title,
        status: TranscriptionStatus.PENDING,
        status_message: 'در صف پردازش',
        expected_person_ids: input.expectedPersonIds ?? [],
      }),
    );

    // Persist each uploaded file to S3 and record it (order preserved).
    const localPaths: string[] = [];
    for (let i = 0; i < input.files.length; i++) {
      const f = input.files[i];
      localPaths.push(f.path);
      const stored = await this.fileService.uploadFileFromPath(f.path, {
        file_type: 'audio',
        name: f.originalname,
        user: null,
      });
      await this.audioRepo.save(
        this.audioRepo.create({
          transcription_id: transcription.id,
          audio_id: stored.id,
          order: i + 1,
          original_name: f.originalname,
        }),
      );
    }

    // Fire-and-forget: process in the background so the request returns fast.
    this.processTranscription(transcription.id, localPaths).catch((error) => {
      this.logger.error(
        `Processing failed for transcription ${transcription.id}: ${error?.message}`,
      );
    });

    return transcription;
  }

  async list(): Promise<Transcription[]> {
    // Avoid pulling the large text/segment/token columns in the list view.
    return this.transcriptionRepo
      .createQueryBuilder('t')
      .select([
        't.id',
        't.title',
        't.status',
        't.status_message',
        't.duration',
        't.speaker_samples',
        't.expected_person_ids',
        't.created_at',
        't.updated_at',
      ])
      .orderBy('t.created_at', 'DESC')
      .getMany();
  }

  /** Full detail with presigned playback URLs for the audio + speaker clips. */
  async getDetail(id: number): Promise<any> {
    const transcription = await this.transcriptionRepo.findOne({
      where: { id },
    });
    if (!transcription) {
      throw new HttpException('رونویسی یافت نشد', 404);
    }

    let processedAudioUrl: string | null = null;
    if (transcription.processed_audio?.path) {
      processedAudioUrl = await this.safePresign(
        transcription.processed_audio.path,
      );
    }

    const speakerSamples = await Promise.all(
      (transcription.speaker_samples ?? []).map(async (s) => ({
        ...s,
        audioUrl: await this.safePresign(s.audioPath),
        personId: transcription.speaker_map?.[s.speakerId] ?? null,
      })),
    );

    // Attach the persons referenced by this transcription (expected + mapped)
    // so the frontend can resolve names without extra round-trips.
    const personIds = new Set<number>();
    (transcription.expected_person_ids ?? []).forEach((pid) => personIds.add(pid));
    Object.values(transcription.speaker_map ?? {}).forEach((pid) => {
      if (pid != null) personIds.add(pid);
    });
    speakerSamples.forEach((s) => {
      if (s.suggestedPersonId != null) personIds.add(s.suggestedPersonId);
    });
    const persons = await this.personService.findByIds([...personIds]);

    return {
      ...transcription,
      processed_audio_url: processedAudioUrl,
      speaker_samples: speakerSamples,
      persons,
    };
  }

  async getStatus(id: number): Promise<any> {
    const t = await this.transcriptionRepo
      .createQueryBuilder('t')
      .select([
        't.id',
        't.status',
        't.status_message',
        't.speaker_samples_status',
      ])
      .where('t.id = :id', { id })
      .getOne();
    if (!t) {
      throw new HttpException('رونویسی یافت نشد', 404);
    }
    return t;
  }

  async updateTitle(id: number, title: string): Promise<Transcription> {
    const t = await this.transcriptionRepo.findOne({ where: { id } });
    if (!t) throw new HttpException('رونویسی یافت نشد', 404);
    t.title = title;
    return this.transcriptionRepo.save(t);
  }

  async remove(id: number): Promise<{ success: boolean }> {
    const t = await this.transcriptionRepo.findOne({ where: { id } });
    if (!t) throw new HttpException('رونویسی یافت نشد', 404);
    await this.audioRepo.delete({ transcription_id: id });
    await this.transcriptionRepo.remove(t);
    return { success: true };
  }

  // ---------------------------------------------------------------------------
  // Background processing pipeline
  // ---------------------------------------------------------------------------

  async processTranscription(id: number, localPaths: string[]): Promise<void> {
    this.logger.log(`[Process] Starting transcription ${id}`);
    let processedPath: string | null = null;

    try {
      await this.setStatus(
        id,
        TranscriptionStatus.PROCESSING,
        'در حال آماده‌سازی صدا...',
      );

      // 1. Produce a single processed MP3 (merge if multiple).
      processedPath =
        localPaths.length === 1
          ? await this.audioProcessor.transcodeToStreamingMp3(localPaths[0])
          : (await this.audioProcessor.mergeAudioFiles(localPaths)).mergedPath;

      // 2. Store the processed audio in S3 and link it.
      const processedFile = await this.fileService.uploadFileFromPath(
        processedPath,
        {
          file_type: 'audio',
          name: `transcription_${id}_processed.mp3`,
          user: null,
        },
      );
      const duration = await this.audioProcessor.getAudioDuration(processedPath);
      await this.transcriptionRepo.update(id, {
        processed_audio_id: processedFile.id,
        duration,
      });

      const audioUrl = await this.fileService.getPresignedUrl(
        processedFile.path,
        PLAYBACK_URL_TTL,
      );

      // 3. Speech-to-text (Soniox).
      await this.setStatus(
        id,
        TranscriptionStatus.PROCESSING,
        'در حال تبدیل گفتار به متن...',
      );
      const { tokens } = await this.runSoniox(audioUrl, processedPath, id);

      // 4. Diarization / identification (Pyannote).
      await this.setStatus(
        id,
        TranscriptionStatus.PROCESSING,
        'در حال تشخیص گویندگان...',
      );
      const expectedPersonIds =
        (await this.getExpectedPersonIds(id)) ?? [];
      const { diarization, suggestedMap, source } = await this.runDiarization(
        audioUrl,
        expectedPersonIds,
      );

      // 5. Merge transcript + diarization.
      const segments = this.merger.mergeTranscripts(diarization, tokens);
      const rawText = this.merger.generateRawText(segments);

      await this.transcriptionRepo
        .createQueryBuilder()
        .update()
        .set({
          stt_tokens: tokens as any,
          diarization: diarization as any,
          segments: segments as any,
          raw_text: rawText,
          diarization_source: source,
        })
        .where('id = :id', { id })
        .execute();

      // 6. Per-speaker audio samples (extracted from the local processed file).
      await this.setStatus(
        id,
        TranscriptionStatus.PROCESSING,
        'در حال تولید نمونه صدای گویندگان...',
      );
      await this.transcriptionRepo.update(id, {
        speaker_samples_status: 'processing',
      });
      const effectiveDiarization =
        diarization.length > 0
          ? diarization
          : this.deriveDiarizationFromTokens(tokens);
      const samples = await this.buildSpeakerSamples(
        id,
        processedPath,
        effectiveDiarization,
        tokens,
        suggestedMap,
      );
      await this.transcriptionRepo.update(id, {
        speaker_samples: samples,
        speaker_samples_status: samples.length > 0 ? 'done' : 'failed',
      });

      // 7. Ready for the user to confirm speaker → person mapping.
      await this.setStatus(
        id,
        TranscriptionStatus.AWAITING_MAPPING,
        'آماده تطبیق گویندگان',
      );
      this.logger.log(`[Process] Transcription ${id} ready for mapping`);
    } catch (error: any) {
      this.logger.error(`[Process] Transcription ${id} failed: ${error?.message}`);
      await this.setStatus(
        id,
        TranscriptionStatus.FAILED,
        `خطا در پردازش: ${error?.message ?? 'نامشخص'}`,
      );
    } finally {
      // Cleanup local temp files.
      this.audioProcessor.safeUnlink(processedPath);
      localPaths.forEach((p) => this.audioProcessor.safeUnlink(p));
    }
  }

  private async runSoniox(
    audioUrl: string,
    localPath: string,
    id: number,
  ): Promise<{ tokens: SonioxToken[] }> {
    if (!this.soniox.isConfigured()) {
      throw new Error('SONIOX_API_KEY تنظیم نشده است');
    }
    try {
      const { tokens } = await this.soniox.transcribeWithSonioxUrl(
        audioUrl,
        `t${id}`,
      );
      return { tokens };
    } catch (error) {
      this.logger.warn(
        `Soniox audio_url path failed for ${id}, falling back to file upload`,
      );
      const { tokens } = await this.soniox.transcribeWithSonioxFile(
        localPath,
        `t${id}`,
      );
      return { tokens };
    }
  }

  /**
   * Decide between plain diarization and voiceprint-based identification. When
   * expected persons have stored voiceprints we run /identify and derive a
   * suggested speaker → person mapping; otherwise plain /diarize.
   */
  private async runDiarization(
    audioUrl: string,
    expectedPersonIds: number[],
  ): Promise<{
    diarization: PyannoteSegment[];
    suggestedMap: Record<string, { personId: number; confidence: number }>;
    source: 'pyannote' | 'identify' | 'soniox';
  }> {
    if (!this.pyannote.isConfigured()) {
      this.logger.warn('Pyannote not configured — using Soniox speakers only');
      return { diarization: [], suggestedMap: {}, source: 'soniox' };
    }

    const voiceprints = await this.personService.getVoiceprintInputs(
      expectedPersonIds,
    );

    if (voiceprints.length > 0) {
      try {
        const { diarization, matches } = await this.pyannote.identifySpeakers(
          audioUrl,
          voiceprints,
          { threshold: 0, exclusive: true },
        );
        const suggestedMap: Record<
          string,
          { personId: number; confidence: number }
        > = {};
        for (const m of matches) {
          if (m.match) {
            const personId = parseInt(m.match, 10);
            if (!Number.isNaN(personId)) {
              const confidence = m.confidence?.[m.match] ?? 0;
              suggestedMap[m.speaker] = { personId, confidence };
            }
          }
        }
        return { diarization, suggestedMap, source: 'identify' };
      } catch (error: any) {
        this.logger.warn(
          `Pyannote identify failed (${error?.message}), falling back to diarize`,
        );
      }
    }

    const diarization = await this.pyannote.getDiarization(audioUrl);
    return { diarization, suggestedMap: {}, source: 'pyannote' };
  }

  // ---------------------------------------------------------------------------
  // Speaker sample extraction (single processed-audio source)
  // ---------------------------------------------------------------------------

  private async buildSpeakerSamples(
    transcriptionId: number,
    localAudioPath: string,
    diarization: PyannoteSegment[],
    tokens: SonioxToken[],
    suggestedMap: Record<string, { personId: number; confidence: number }>,
  ): Promise<SpeakerSample[]> {
    if (!diarization || diarization.length === 0) return [];

    // Group segments per speaker (skip unknowns).
    const speakerSegments = new Map<
      string,
      Array<{ start: number; end: number }>
    >();
    const allSegments: Array<{ start: number; end: number; speaker: string }> =
      [];
    const speakerOrder: string[] = [];

    for (const seg of [...diarization].sort((a, b) => a.start - b.start)) {
      if (
        seg.speaker === 'SPEAKER_UNKNOWN' ||
        seg.speaker.toLowerCase().includes('unknown')
      ) {
        continue;
      }
      if (!speakerSegments.has(seg.speaker)) {
        speakerSegments.set(seg.speaker, []);
        speakerOrder.push(seg.speaker);
      }
      speakerSegments.get(seg.speaker)!.push({ start: seg.start, end: seg.end });
      allSegments.push({ start: seg.start, end: seg.end, speaker: seg.speaker });
    }
    allSegments.sort((a, b) => a.start - b.start);

    if (speakerOrder.length === 0) return [];

    const numberMap = this.merger.buildSpeakerNumberMap(diarization, tokens);
    const results: SpeakerSample[] = [];
    let fallbackCounter = 0;

    for (const speakerId of speakerOrder) {
      fallbackCounter++;
      const speakerNumber = numberMap.get(speakerId) ?? fallbackCounter;
      const segments = speakerSegments.get(speakerId)!;
      const totalDuration = segments.reduce((sum, s) => sum + (s.end - s.start), 0);

      const { start, duration } = this.pickCleanWindow(
        segments,
        allSegments,
        speakerId,
      );

      try {
        const clipPath = await this.audioProcessor.extractClip(
          localAudioPath,
          start,
          duration,
          `t${transcriptionId}_${speakerId}`,
        );
        const s3Key = await this.fileService.uploadToS3Only(
          clipPath,
          'audio/mpeg',
        );
        this.audioProcessor.safeUnlink(clipPath);

        const suggestion = suggestedMap[speakerId];
        results.push({
          speakerId,
          speakerLabel: `گوینده ${speakerNumber}`,
          speakerNumber,
          audioPath: s3Key,
          totalDuration: Math.round(totalDuration * 10) / 10,
          sampleStart: Math.round(start * 10) / 10,
          sampleEnd: Math.round((start + duration) * 10) / 10,
          suggestedPersonId: suggestion?.personId ?? null,
          suggestedConfidence: suggestion?.confidence ?? null,
        });
      } catch (error: any) {
        this.logger.error(
          `[Samples] Failed for ${speakerId}: ${error?.message}`,
        );
      }
    }

    return results;
  }

  /**
   * Pick a ~30s window for a speaker that minimizes overlap with other
   * speakers, so the sample clearly represents one voice.
   */
  private pickCleanWindow(
    segments: Array<{ start: number; end: number }>,
    allSegments: Array<{ start: number; end: number; speaker: string }>,
    speakerId: string,
  ): { start: number; duration: number } {
    const sorted = [...segments].sort(
      (a, b) => b.end - b.start - (a.end - a.start),
    );
    const others = allSegments.filter((s) => s.speaker !== speakerId);

    let bestStart = sorted[0].start;
    let bestDuration = Math.min(
      TARGET_SAMPLE_DURATION,
      sorted[0].end - sorted[0].start,
    );
    let bestOverlap = Infinity;

    for (const seg of sorted) {
      const segLen = seg.end - seg.start;
      const winLen = Math.min(TARGET_SAMPLE_DURATION, segLen);
      if (winLen < 3) continue;

      let localBest = Infinity;
      let localStart = seg.start;
      for (
        let candStart = seg.start;
        candStart + winLen <= seg.end + 0.001;
        candStart += 1.0
      ) {
        const overlap = this.computeOverlap(
          others,
          candStart,
          candStart + winLen,
        );
        if (overlap < localBest) {
          localBest = overlap;
          localStart = candStart;
          if (overlap <= 0) break;
        }
      }

      if (localBest < bestOverlap) {
        bestOverlap = localBest;
        bestStart = localStart;
        bestDuration = winLen;
        if (bestOverlap <= ALLOWED_OVERLAP_SECONDS) break;
      }
    }

    if (!Number.isFinite(bestOverlap)) {
      const longest = sorted[0];
      const segLen = longest.end - longest.start;
      bestDuration = Math.min(TARGET_SAMPLE_DURATION, segLen);
      bestStart = longest.start + Math.max(0, (segLen - bestDuration) / 2);
    }

    return { start: bestStart, duration: bestDuration };
  }

  private computeOverlap(
    others: Array<{ start: number; end: number }>,
    start: number,
    end: number,
  ): number {
    let overlap = 0;
    for (const s of others) {
      const o = Math.max(0, Math.min(end, s.end) - Math.max(start, s.start));
      overlap += o;
    }
    return overlap;
  }

  /**
   * When Pyannote is unavailable, synthesize diarization-like segments from
   * Soniox speaker numbers so speaker samples/labels still work.
   */
  private deriveDiarizationFromTokens(tokens: SonioxToken[]): PyannoteSegment[] {
    const segments: PyannoteSegment[] = [];
    let current: PyannoteSegment | null = null;

    for (const token of [...tokens].sort((a, b) => a.start_ms - b.start_ms)) {
      const speaker =
        token.speaker !== undefined
          ? `SPEAKER_${token.speaker.toString().padStart(2, '0')}`
          : 'SPEAKER_00';
      const start = token.start_ms / 1000;
      const end = (token.end_ms || token.start_ms) / 1000;

      if (!current || current.speaker !== speaker) {
        if (current) segments.push(current);
        current = { start, end, speaker };
      } else {
        current.end = end;
      }
    }
    if (current) segments.push(current);
    return segments;
  }

  // ---------------------------------------------------------------------------
  // Speaker → person confirmation
  // ---------------------------------------------------------------------------

  /**
   * Persist the user's speaker → person assignments, create voiceprints for
   * newly-assigned persons that don't have one yet (from that speaker's
   * sample clip), rebuild the final transcript with real names and mark the
   * transcription complete.
   */
  async confirmSpeakers(
    id: number,
    assignments: Array<{ speakerId: string; personId?: number | null }>,
  ): Promise<any> {
    const transcription = await this.transcriptionRepo.findOne({
      where: { id },
    });
    if (!transcription) {
      throw new HttpException('رونویسی یافت نشد', 404);
    }

    const speakerMap: Record<string, number | null> = {};
    const samples = transcription.speaker_samples ?? [];

    for (const a of assignments) {
      speakerMap[a.speakerId] = a.personId ?? null;

      if (a.personId) {
        // If this person has no voiceprint yet, create one from this speaker's
        // sample clip so future transcriptions can auto-identify them.
        const sample = samples.find((s) => s.speakerId === a.speakerId);
        if (sample?.audioPath) {
          try {
            const person = await this.personService.findById(a.personId);
            if (!person.has_voiceprint) {
              await this.personService.createVoiceprintFromS3Key(
                a.personId,
                sample.audioPath,
              );
            }
          } catch (error: any) {
            this.logger.warn(
              `Could not create voiceprint for person ${a.personId}: ${error?.message}`,
            );
          }
        }
      }
    }

    // Rebuild final text with resolved person names.
    const persons = await this.personService.findByIds(
      Object.values(speakerMap).filter((v): v is number => v != null),
    );
    const personById = new Map(persons.map((p) => [p.id, p]));
    const finalText = this.buildFinalText(
      transcription.segments ?? [],
      speakerMap,
      personById,
    );

    await this.transcriptionRepo.update(id, {
      speaker_map: speakerMap,
      final_text: finalText,
      status: TranscriptionStatus.COMPLETED,
      status_message: 'تکمیل شد',
    });

    return this.getDetail(id);
  }

  private buildFinalText(
    segments: Transcription['segments'],
    speakerMap: Record<string, number | null>,
    personById: Map<number, any>,
  ): string {
    if (!segments || segments.length === 0) return '';
    const lines: string[] = [];
    for (const seg of segments) {
      if (seg.speaker_id === 'SPEAKER_UNKNOWN') continue;
      const cleanText = seg.text.replace(
        /[\s.,!?؟،؛:;'"()[\]{}«»\-_…]+/g,
        '',
      );
      if (cleanText.length === 0) continue;

      const personId = speakerMap[seg.speaker_id];
      const label =
        personId && personById.get(personId)
          ? personById.get(personId).name
          : seg.speaker_label;
      lines.push(
        `${label} [${seg.start_time} - ${seg.end_time}]: ${seg.text.trim()}`,
      );
    }
    return lines.join('\n\n');
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async setStatus(
    id: number,
    status: TranscriptionStatus,
    message: string,
  ): Promise<void> {
    await this.transcriptionRepo.update(id, {
      status,
      status_message: message,
    });
  }

  private async getExpectedPersonIds(id: number): Promise<number[] | null> {
    const t = await this.transcriptionRepo
      .createQueryBuilder('t')
      .select(['t.id', 't.expected_person_ids'])
      .where('t.id = :id', { id })
      .getOne();
    return t?.expected_person_ids ?? [];
  }

  private async safePresign(s3Key?: string | null): Promise<string | null> {
    if (!s3Key) return null;
    try {
      return await this.fileService.getPresignedUrl(s3Key, PLAYBACK_URL_TTL);
    } catch {
      return null;
    }
  }
}
