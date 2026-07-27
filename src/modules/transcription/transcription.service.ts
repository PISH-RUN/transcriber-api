import { HttpException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import {
  SpeakerSample,
  Transcription,
  TranscriptionAudio,
  TranscriptionStatus,
} from './transcription.entity';
import { FileService } from '../file/file.service';
import { PersonService } from '../person/person.service';
import { ProjectService } from '../project/project.service';
import { AnalysisService } from '../analysis/analysis.service';
import { GlossaryScanService } from '../glossary/glossary-scan.service';
import { TranscriptRefineService } from '../ai/transcript-refine.service';
import { AudioProcessorService } from '../audio/audio-processor.service';
import { SonioxClientService } from '../audio/soniox-client.service';
import { PyannoteService, PyannoteSegment } from '../audio/pyannote.service';
import {
  SonioxToken,
  TranscriptMergerService,
} from '../audio/transcript-merger.service';

const PLAYBACK_URL_TTL = 6 * 60 * 60; // 6h

/**
 * How long a run may go without touching the row before it is presumed dead.
 *
 * The pipeline is fire-and-forget in memory, so an API restart mid-run leaves
 * the row `processing` for ever with nothing left to finish it. Every step
 * writes a status message, and the longest single step (Pyannote polling) has
 * its own timeout well under this, so silence this long means the process is
 * gone and a retry is safe rather than a second concurrent run.
 */
const STALE_RUN_MS = 2 * 60 * 60 * 1000; // 2h
const TARGET_SAMPLE_DURATION = 30; // seconds
const ALLOWED_OVERLAP_SECONDS = 1.0;

export interface CreateTranscriptionInput {
  title: string;
  expectedPersonIds: number[];
  files: Array<{ path: string; originalname: string }>;
  description?: string | null;
  /** Calendar date the session happened, "YYYY-MM-DD". */
  recordedAt?: string | null;
  tags?: string[];
  /** File under an existing project… */
  projectId?: number | null;
  /** …or under a project named here, created on the fly if it's new. */
  projectName?: string | null;
}

/** Filters accepted by the list endpoint. */
export interface ListTranscriptionsFilter {
  search?: string;
  /** Project id, or the string 'none' for "not filed under any project". */
  projectId?: number | 'none';
  status?: TranscriptionStatus[];
  /** Inclusive date range over the session date (falling back to upload date). */
  from?: string;
  to?: string;
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
    private readonly refiner: TranscriptRefineService,
    private readonly projectService: ProjectService,
    private readonly analysisService: AnalysisService,
    private readonly glossaryScan: GlossaryScanService,
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

    const projectId = await this.resolveProjectId(
      input.projectId,
      input.projectName,
    );

    const transcription = await this.transcriptionRepo.save(
      this.transcriptionRepo.create({
        title: input.title,
        status: TranscriptionStatus.PENDING,
        status_message: 'در صف پردازش',
        expected_person_ids: input.expectedPersonIds ?? [],
        description: input.description?.trim() || null,
        recorded_at: input.recordedAt || null,
        tags: this.normalizeTags(input.tags),
        project_id: projectId,
      }),
    );

    // Persist each uploaded file to S3 and record it (order preserved).
    const localPaths: string[] = [];
    try {
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
    } catch (error: any) {
      // The row already exists, so a failure here used to leave it `pending`
      // for ever with no audio attached and nothing running: the upload error
      // went back as a 500 while the row sat in the list looking queued. Mark
      // it failed so the state is honest and the recording can be dealt with.
      this.logger.error(
        `[Create] Transcription ${transcription.id}: storing audio failed: ${error?.message}`,
      );
      await this.setStatus(
        transcription.id,
        TranscriptionStatus.FAILED,
        `خطا در ذخیره فایل صوتی: ${error?.message ?? 'نامشخص'}`,
      );
      localPaths.forEach((p) => this.audioProcessor.safeUnlink(p));
      throw new HttpException(
        `فایل صوتی ذخیره نشد: ${error?.message ?? 'نامشخص'}`,
        500,
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

  /**
   * Run the pipeline again for a recording that did not make it through.
   *
   * Without this a single upstream hiccup — a Pyannote job that comes back
   * `failed: unknown error`, a network blip during speech-to-text — is a dead
   * end: the recording is stuck on a page with nothing but the error on it, and
   * the only way forward is deleting it and uploading the audio again.
   *
   * The original uploads are still in S3, so a retry re-downloads them and
   * re-enters the exact same pipeline. Nothing is resumed from halfway: the
   * Soniox tokens are only written once diarization has succeeded too, so after
   * a diarization failure there is no partial result worth keeping.
   */
  async retryProcessing(id: number): Promise<any> {
    const t = await this.transcriptionRepo.findOne({
      where: { id },
      relations: ['audioFiles'],
    });
    if (!t) throw new HttpException('رونویسی یافت نشد', 404);

    if (
      t.status === TranscriptionStatus.COMPLETED ||
      t.status === TranscriptionStatus.AWAITING_MAPPING
    ) {
      throw new HttpException('این رونویسی با موفقیت پردازش شده است', 400);
    }

    const idleMs = Date.now() - new Date(t.updated_at ?? 0).getTime();
    if (t.status !== TranscriptionStatus.FAILED && idleMs < STALE_RUN_MS) {
      throw new HttpException('پردازش این رونویسی در حال اجراست', 409);
    }

    // Prefer the original uploads (in order) — the same input the first run had.
    // The processed MP3 is the fallback for rows whose originals are gone.
    const sources = [...(t.audioFiles ?? [])]
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((audio) => ({
        key: audio.audio?.path,
        name: audio.original_name || audio.audio?.name || `audio-${audio.id}`,
      }))
      .filter(
        (source): source is { key: string; name: string } => !!source.key,
      );

    if (sources.length === 0 && t.processed_audio?.path) {
      sources.push({
        key: t.processed_audio.path,
        name: `transcription_${id}_processed.mp3`,
      });
    }

    if (sources.length === 0) {
      throw new HttpException(
        'فایل صوتی این رونویسی در انبار موجود نیست، پس پردازش دوباره ممکن نیست',
        422,
      );
    }

    await this.setStatus(
      id,
      TranscriptionStatus.PROCESSING,
      'در حال آماده‌سازی برای پردازش دوباره...',
    );

    this.restartProcessing(id, sources).catch((error) => {
      this.logger.error(
        `[Retry] Transcription ${id} could not be restarted: ${error?.message}`,
      );
    });

    return this.getStatus(id);
  }

  /** Bring the audio back to local disk, then hand it to the normal pipeline. */
  private async restartProcessing(
    id: number,
    sources: Array<{ key: string; name: string }>,
  ): Promise<void> {
    this.logger.log(
      `[Retry] Transcription ${id}: re-downloading ${sources.length} file(s)`,
    );

    const dir = path.join(process.cwd(), 'temp', 'uploads');
    fs.mkdirSync(dir, { recursive: true });

    const localPaths: string[] = [];
    try {
      for (let i = 0; i < sources.length; i++) {
        const buffer = await this.fileService.downloadFileFromS3(
          sources[i].key,
        );
        const target = path.join(
          dir,
          `retry-${id}-${Date.now()}-${i}${path.extname(sources[i].name) || '.mp3'}`,
        );
        fs.writeFileSync(target, buffer);
        localPaths.push(target);
      }
    } catch (error: any) {
      // The download is the one part outside `processTranscription`, so its
      // failure has to be reported the same way the pipeline reports its own.
      this.logger.error(
        `[Retry] Transcription ${id}: download failed: ${error?.message}`,
      );
      localPaths.forEach((p) => this.audioProcessor.safeUnlink(p));
      await this.setStatus(
        id,
        TranscriptionStatus.FAILED,
        `خطا در دریافت فایل صوتی برای پردازش دوباره: ${error?.message ?? 'نامشخص'}`,
      );
      return;
    }

    // Cleans up `localPaths` itself, and owns the status from here on.
    await this.processTranscription(id, localPaths);
  }

  /**
   * List view, filtered server-side so finding one recording among hundreds
   * doesn't depend on shipping the whole table to the browser. The large
   * text/segment/token columns are never selected here.
   */
  async list(filter: ListTranscriptionsFilter = {}): Promise<Transcription[]> {
    const query = this.transcriptionRepo
      .createQueryBuilder('t')
      .leftJoin('t.project', 'p')
      .select([
        't.id',
        't.title',
        't.description',
        't.recorded_at',
        't.tags',
        't.project_id',
        't.status',
        't.status_message',
        't.duration',
        't.speaker_samples',
        't.expected_person_ids',
        't.created_at',
        't.updated_at',
        'p.id',
        'p.name',
        'p.color',
      ]);

    const search = filter.search?.trim();
    if (search) {
      // `tags` is jsonb — cast to text so a tag substring is searchable too.
      query.andWhere(
        `(t.title ILIKE :q OR t.description ILIKE :q OR p.name ILIKE :q OR CAST(t.tags AS TEXT) ILIKE :q)`,
        { q: `%${search}%` },
      );
    }

    if (filter.projectId === 'none') {
      query.andWhere('t.project_id IS NULL');
    } else if (typeof filter.projectId === 'number') {
      query.andWhere('t.project_id = :projectId', {
        projectId: filter.projectId,
      });
    }

    if (filter.status?.length) {
      query.andWhere('t.status IN (:...statuses)', {
        statuses: filter.status,
      });
    }

    // Filter on the session date, falling back to the upload date for
    // recordings that were uploaded without one.
    if (filter.from) {
      query.andWhere('COALESCE(t.recorded_at, t.created_at::date) >= :from', {
        from: filter.from,
      });
    }
    if (filter.to) {
      query.andWhere('COALESCE(t.recorded_at, t.created_at::date) <= :to', {
        to: filter.to,
      });
    }

    return query.orderBy('t.created_at', 'DESC').getMany();
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
    (transcription.expected_person_ids ?? []).forEach((pid) =>
      personIds.add(pid),
    );
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
      ai_refine_available: this.refiner.isConfigured(),
      can_revert_refine: await this.hasRefineBackup(id),
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
        't.refine_status',
        't.refine_message',
      ])
      .where('t.id = :id', { id })
      .getOne();
    if (!t) {
      throw new HttpException('رونویسی یافت نشد', 404);
    }
    return t;
  }

  /**
   * Update an existing transcription's title and/or its speaker-attributed
   * segments (the user editing a line's text or reassigning a line to a
   * different speaker). When segments change we rebuild the derived
   * `raw_text` / `final_text` so exports and any downstream consumers stay in
   * sync with the edited conversation.
   */
  async update(
    id: number,
    dto: {
      title?: string;
      description?: string | null;
      recorded_at?: string | null;
      tags?: string[] | null;
      project_id?: number | null;
      interviewer_speaker_ids?: string[] | null;
      segments?: Transcription['segments'];
    },
  ): Promise<any> {
    const t = await this.transcriptionRepo.findOne({ where: { id } });
    if (!t) throw new HttpException('رونویسی یافت نشد', 404);

    const patch: Partial<Transcription> = {};

    if (dto.title !== undefined) {
      patch.title = dto.title;
    }
    if (dto.description !== undefined) {
      patch.description = dto.description?.trim() || null;
    }
    if (dto.recorded_at !== undefined) {
      patch.recorded_at = dto.recorded_at || null;
    }
    if (dto.tags !== undefined) {
      patch.tags = this.normalizeTags(dto.tags ?? undefined);
    }
    if (dto.interviewer_speaker_ids !== undefined) {
      const ids = [
        ...new Set(
          (dto.interviewer_speaker_ids ?? [])
            .map((value) => String(value).trim())
            .filter((value) => value.length > 0),
        ),
      ];
      patch.interviewer_speaker_ids = ids.length ? ids : null;
    }
    if (dto.project_id !== undefined) {
      patch.project_id =
        dto.project_id == null
          ? null
          : (await this.projectService.findById(dto.project_id)).id;
    }

    if (dto.segments !== undefined) {
      // Normalize: collapse adjacent segments that share a speaker (e.g. after
      // the user reassigns a line to match its neighbour) into one block.
      Object.assign(
        patch,
        await this.buildSegmentsPatch(dto.segments ?? [], t.speaker_map ?? {}),
      );
    }

    if (Object.keys(patch).length > 0) {
      await this.transcriptionRepo.update(id, patch);
    }

    // Analyses carry a denormalized project id for taxonomy counting; keep it
    // in step when the recording is re-filed.
    if (dto.project_id !== undefined) {
      await this.analysisService.syncProject(id, patch.project_id ?? null);
      // Filing a recording under a project is the first moment that project's
      // glossary can apply to it.
      this.autoScanGlossary(id, patch.project_id ?? null);
    } else if (dto.segments !== undefined) {
      this.autoScanGlossary(id, t.project_id ?? null);
    }

    return this.getDetail(id);
  }

  /**
   * Everything that has to be written when `segments` change: the normalized
   * segments plus both derived transcripts. Shared by the manual edit endpoint,
   * the AI refinement pass and the revert, so the three can never drift apart.
   */
  private async buildSegmentsPatch(
    segments: NonNullable<Transcription['segments']>,
    speakerMap: Record<string, number | null>,
  ): Promise<Partial<Transcription>> {
    const normalized = this.mergeConsecutiveSpeakers(segments);

    const persons = await this.personService.findByIds(
      Object.values(speakerMap).filter((v): v is number => v != null),
    );
    const personById = new Map(persons.map((p) => [p.id, p]));

    return {
      segments: normalized as any,
      // Anonymous-label transcript (uses speaker_label).
      raw_text: this.merger.generateRawText(normalized as any),
      // Named transcript, using the saved speaker → person map.
      final_text: this.buildFinalText(normalized, speakerMap, personById),
    };
  }

  /**
   * Merge adjacent segments that share the same speaker_id into a single
   * segment (text space-joined, end time/ms taken from the later one). Mirrors
   * the pipeline's post-merge normalization so user edits keep the "one block
   * per continuous speaker turn" invariant.
   */
  private mergeConsecutiveSpeakers(
    segments: NonNullable<Transcription['segments']>,
  ): NonNullable<Transcription['segments']> {
    const result: NonNullable<Transcription['segments']> = [];
    for (const seg of segments) {
      const last = result[result.length - 1];
      if (last && last.speaker_id === seg.speaker_id) {
        const left = (last.text ?? '').trim();
        const right = (seg.text ?? '').trim();
        last.text = left && right ? `${left} ${right}` : left || right;
        last.end_time = seg.end_time;
        last.end_ms = seg.end_ms;
      } else {
        result.push({ ...seg });
      }
    }
    return result;
  }

  /**
   * Rebuild `segments` from the stored Soniox tokens + Pyannote diarization.
   *
   * The raw STT/diarization output is kept on the row, so an improvement to the
   * merger (for example word-boundary-safe speaker attribution) can be applied
   * to transcriptions that were already processed — without paying for STT
   * again. Manual text edits are lost, which is why this is an explicit action.
   */
  async remergeSegments(id: number): Promise<any> {
    const t = await this.transcriptionRepo
      .createQueryBuilder('t')
      .addSelect(['t.stt_tokens', 't.diarization'])
      .where('t.id = :id', { id })
      .getOne();

    if (!t) throw new HttpException('رونویسی یافت نشد', 404);
    if (!t.stt_tokens?.length) {
      throw new HttpException(
        'توکن‌های گفتار برای این رونویسی ذخیره نشده است',
        400,
      );
    }

    const segments = this.merger.mergeTranscripts(
      (t.diarization ?? []) as any,
      t.stt_tokens as any,
    );
    if (segments.length === 0) {
      throw new HttpException('بازسازی متن نتیجه‌ای نداشت', 422);
    }

    const patch = await this.buildSegmentsPatch(
      segments as any,
      t.speaker_map ?? {},
    );

    await this.transcriptionRepo.update(id, {
      ...patch,
      // The previous text is gone, so a "revert to pre-AI" snapshot taken
      // against it would be misleading.
      segments_before_refine: null as any,
      refine_status: null as any,
      refine_message: null as any,
      refined_at: null as any,
    });

    this.logger.log(
      `[Remerge] Transcription ${id}: ${t.stt_tokens.length} tokens -> ${segments.length} turns`,
    );

    // Line boundaries moved, so previously recorded positions are stale; the
    // scan re-establishes them for whatever is still findable.
    this.autoScanGlossary(id, t.project_id ?? null);

    return this.getDetail(id);
  }

  // ---------------------------------------------------------------------------
  // AI proof-reading (Gemini 2.5 Flash)
  // ---------------------------------------------------------------------------

  /**
   * Kick off a Gemini clean-up pass over the transcript. Returns immediately;
   * the frontend follows `refine_status` / `refine_message` while it runs,
   * because a long meeting takes minutes and would blow any HTTP timeout.
   */
  async startAiRefine(id: number): Promise<any> {
    if (!this.refiner.isConfigured()) {
      throw new HttpException(
        'سرویس هوش مصنوعی تنظیم نشده است (OPENROUTER_API_KEY یا GEMINI_API_KEY)',
        503,
      );
    }

    const t = await this.transcriptionRepo.findOne({ where: { id } });
    if (!t) throw new HttpException('رونویسی یافت نشد', 404);
    if (t.refine_status === 'processing') {
      throw new HttpException('اصلاح هوشمند در حال اجراست', 409);
    }
    if (!t.segments || t.segments.length === 0) {
      throw new HttpException('متنی برای اصلاح وجود ندارد', 400);
    }

    await this.transcriptionRepo.update(id, {
      refine_status: 'processing',
      refine_message: 'در صف اصلاح هوشمند...',
    });

    this.runAiRefine(id).catch((error) => {
      this.logger.error(
        `[Refine] Transcription ${id} failed: ${error?.message}`,
      );
    });

    return this.getStatus(id);
  }

  private async runAiRefine(id: number): Promise<void> {
    this.logger.log(
      `[Refine] Starting transcription ${id} (${this.refiner.model})`,
    );

    try {
      const t = await this.transcriptionRepo.findOne({ where: { id } });
      if (!t?.segments?.length) throw new Error('متنی برای اصلاح وجود ندارد');

      const original = t.segments;

      // Snapshot before touching anything, so "بازگردانی متن اصلی" always has
      // the pre-refinement version available.
      await this.transcriptionRepo.update(id, {
        segments_before_refine: original as any,
        refine_message: 'در حال اصلاح متن با هوش مصنوعی...',
      });

      const { texts, changed, rejected, failedBatches, totalBatches } =
        await this.refiner.refineSegments(original, async (done, total) => {
          // One row update per finished batch — that's what the frontend polls.
          await this.transcriptionRepo.update(id, {
            refine_message: `اصلاح هوشمند: بخش ${done} از ${total}`,
          });
        });

      if (totalBatches > 0 && failedBatches === totalBatches) {
        throw new Error('هیچ بخشی از متن اصلاح نشد');
      }

      // Only the text of each line changes — speaker, order and timings are
      // preserved exactly, so the audio timeline stays aligned.
      const refined = original.map((segment, index) => ({
        ...segment,
        text: texts[index] ?? segment.text,
      }));

      // `speaker_map` may have changed while the job ran; re-read it.
      const current = await this.transcriptionRepo.findOne({ where: { id } });
      const patch = await this.buildSegmentsPatch(
        refined,
        current?.speaker_map ?? t.speaker_map ?? {},
      );

      const notes: string[] = [`${changed} خط اصلاح شد`];
      if (rejected > 0) notes.push(`${rejected} پیشنهاد نامعتبر رد شد`);
      if (failedBatches > 0) notes.push(`${failedBatches} بخش اصلاح نشد`);

      await this.transcriptionRepo.update(id, {
        ...patch,
        refine_status: 'done',
        refine_message: notes.join(' · '),
        refined_at: new Date(),
      });

      this.logger.log(
        `[Refine] Transcription ${id} done: ${changed} changed, ${rejected} rejected, ${failedBatches}/${totalBatches} batches failed`,
      );

      // Proof-reading fixes exactly the kind of misspelling that stopped a term
      // from being found, so the text is worth re-scanning now.
      this.autoScanGlossary(id, current?.project_id ?? t.project_id ?? null);
    } catch (error: any) {
      await this.transcriptionRepo.update(id, {
        refine_status: 'failed',
        refine_message: `خطا در اصلاح هوشمند: ${error?.message ?? 'نامشخص'}`,
      });
      throw error;
    }
  }

  /** Put back the pre-refinement (raw STT) segments. */
  async revertAiRefine(id: number): Promise<any> {
    const t = await this.transcriptionRepo
      .createQueryBuilder('t')
      .addSelect('t.segments_before_refine')
      .where('t.id = :id', { id })
      .getOne();

    if (!t) throw new HttpException('رونویسی یافت نشد', 404);
    if (t.refine_status === 'processing') {
      throw new HttpException('اصلاح هوشمند در حال اجراست', 409);
    }
    if (!t.segments_before_refine?.length) {
      throw new HttpException('نسخه پیش از اصلاح هوشمند موجود نیست', 400);
    }

    const patch = await this.buildSegmentsPatch(
      t.segments_before_refine,
      t.speaker_map ?? {},
    );

    await this.transcriptionRepo.update(id, {
      ...patch,
      segments_before_refine: null as any,
      refine_status: null as any,
      refine_message: null as any,
      refined_at: null as any,
    });

    return this.getDetail(id);
  }

  /** Does this transcription still have a pre-refinement snapshot to go back to? */
  private async hasRefineBackup(id: number): Promise<boolean> {
    const rows = await this.transcriptionRepo.query(
      'SELECT segments_before_refine IS NOT NULL AS has FROM transcriptions WHERE id = $1',
      [id],
    );
    return !!rows?.[0]?.has;
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
      const duration =
        await this.audioProcessor.getAudioDuration(processedPath);
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
      const expectedPersonIds = (await this.getExpectedPersonIds(id)) ?? [];
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
      this.logger.error(
        `[Process] Transcription ${id} failed: ${error?.message}`,
      );
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

    const voiceprints =
      await this.personService.getVoiceprintInputs(expectedPersonIds);

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
      speakerSegments
        .get(seg.speaker)!
        .push({ start: seg.start, end: seg.end });
      allSegments.push({
        start: seg.start,
        end: seg.end,
        speaker: seg.speaker,
      });
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
      const totalDuration = segments.reduce(
        (sum, s) => sum + (s.end - s.start),
        0,
      );

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
  private deriveDiarizationFromTokens(
    tokens: SonioxToken[],
  ): PyannoteSegment[] {
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

    // The text is final and the speakers are settled, so this is the moment the
    // project's existing glossary can be matched against it.
    this.autoScanGlossary(id, transcription.project_id ?? null);

    return this.getDetail(id);
  }

  /**
   * Link the project's existing glossary to this transcript, without being
   * asked. A dictionary that has to be re-scanned by hand every time is a
   * dictionary that quietly goes stale.
   *
   * Deliberately fire-and-forget: the caller is an HTTP request that must not
   * wait on it, and a failed scan must never fail the action that triggered it.
   * The scan is idempotent, so the manual button remains a safe retry.
   */
  private autoScanGlossary(id: number, projectId: number | null): void {
    if (!projectId) return;

    this.glossaryScan
      .scan({ projectId, transcriptionId: id })
      .then((result) => {
        if (result.mentions_created > 0) {
          this.logger.log(
            `[Glossary] Auto-scan of transcription ${id}: ${result.mentions_created} mention(s) linked`,
          );
        }
      })
      .catch((error) => {
        this.logger.warn(
          `[Glossary] Auto-scan of transcription ${id} failed: ${error?.message}`,
        );
      });
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
      const cleanText = seg.text.replace(/[\s.,!?؟،؛:;'"()[\]{}«»\-_…]+/g, '');
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

  /** Trim, drop blanks and de-duplicate tags; an empty list is stored as null. */
  private normalizeTags(tags?: string[] | null): string[] | null {
    if (!tags?.length) return null;
    const cleaned = [
      ...new Set(tags.map((tag) => String(tag).trim()).filter(Boolean)),
    ];
    return cleaned.length ? cleaned : null;
  }

  /**
   * An upload either points at an existing project, or names one — in which
   * case it is created now so the user doesn't have to set it up beforehand.
   */
  private async resolveProjectId(
    projectId?: number | null,
    projectName?: string | null,
  ): Promise<number | null> {
    if (projectId != null) {
      const project = await this.projectService.findById(projectId);
      return project.id;
    }
    if (projectName?.trim()) {
      const project = await this.projectService.findOrCreateByName(projectName);
      return project.id;
    }
    return null;
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
