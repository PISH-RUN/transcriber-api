import { HttpException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  SpeakerSample,
  Transcription,
  TranscriptionStatus,
} from './transcription.entity';
import { FileService } from '../file/file.service';
import { PersonService, VoiceprintCandidate } from '../person/person.service';
import {
  PyannoteService,
  PyannoteVoiceprintInput,
} from '../audio/pyannote.service';

/** One pyannote identify job takes at most 50 voiceprints. */
const MAX_VOICEPRINTS = 50;

/**
 * Minimum pyannote confidence (0–100) for suggesting a person.
 *
 * Identification during processing gets away with threshold 0, because it only
 * compares against the people the uploader said would be there. Here the whole
 * library is on the table, and pyannote always returns a best match — so
 * without a floor, someone who isn't in the library would still be
 * "recognised" as whoever sounds least unlike them.
 *
 * Pyannote suggests starting at 50 and raising it when wrong names appear. On a
 * real recording checked against voiceprints taken from a different one, every
 * true match scored 90 while the closest *wrong* person — a similar voice —
 * reached 60, above 50. Hence 70. (Against voiceprints cut from the same
 * recording everything scores higher: 90–95 true, up to 80 wrong.) Each run
 * logs the top scores per speaker, for re-tuning on more data.
 */
export const MIN_MATCH_CONFIDENCE = 70;

/** Sample clips identified in parallel — each one is its own pyannote job. */
const CONCURRENCY = 3;

/** A sample clip is at most 30s; its identify job never needs the URL long. */
const CLIP_URL_TTL = 60 * 60; // 1h

/** How long a finished run's outcome stays readable by the mapping screen. */
const STATE_TTL_MS = 30 * 60 * 1000; // 30 min

export type SpeakerIdentifyStatus = 'processing' | 'done' | 'failed';

/** What the detail and status endpoints report about the latest run. */
export interface SpeakerIdentifyState {
  speaker_identify_status: SpeakerIdentifyStatus | null;
  speaker_identify_message: string | null;
}

interface RunState {
  status: SpeakerIdentifyStatus;
  message: string | null;
  at: number;
}

/**
 * Statuses with speakers to match: waiting for mapping, or completed with some
 * speakers left without a person (asked for explicitly, from the list).
 */
const IDENTIFIABLE: TranscriptionStatus[] = [
  TranscriptionStatus.AWAITING_MAPPING,
  TranscriptionStatus.COMPLETED,
];

interface IdentifyPlan {
  /** Samples to send to pyannote in this run. */
  samples: SpeakerSample[];
  /** Library voiceprints to compare them with. */
  candidates: VoiceprintCandidate[];
  /** `<personId>:<version>` of every candidate, recorded on each checked sample. */
  fingerprints: string[];
}

/** Why a run did not start — shown to whoever asked for it. */
export type IdentifySkipReason =
  | 'running'
  | 'not_ready'
  | 'not_configured'
  | 'no_samples'
  | 'all_assigned'
  | 'no_voiceprints'
  | 'up_to_date';

interface IdentifySkip {
  reason: IdentifySkipReason;
  message: string;
}

export type IdentifyStartResult = SpeakerIdentifyState & {
  started: boolean;
  reason?: IdentifySkipReason;
  message?: string;
};

/** A scored sample: the clip it was scored on, and its match if any. */
interface SampleResult {
  audioPath: string;
  match: SpeakerMatch | null;
}

export interface SpeakerMatch {
  personId: number;
  confidence: number;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' && error ? error : 'نامشخص';
}

function skip(reason: IdentifySkipReason, message: string): IdentifySkip {
  return { reason, message };
}

/** A suggestion strong enough to stand without being checked again. */
function isConfident(sample: SpeakerSample): boolean {
  return (
    sample.suggestedPersonId != null &&
    (sample.suggestedConfidence ?? 0) >= MIN_MATCH_CONFIDENCE
  );
}

/**
 * The person a speaker sounds most like, or `null` when even that resemblance
 * is too weak to suggest.
 *
 * Deliberately per speaker, with no "one speaker per person" rule on top.
 * Diarization often splits one person into several speaker ids — on a real
 * two-hour recording, five ids for three people — and each split scores high
 * for that same person. Forcing each person onto a single speaker pushed the
 * second split onto its runner-up, a different person at 60: a wrong name,
 * pre-filled. So a speaker gets its own best match or nothing, never a
 * runner-up, and several speakers may be suggested the same person — which the
 * mapping screen allows anyway.
 */
export function bestMatch(
  byPerson: Map<number, number>,
  minConfidence: number,
): SpeakerMatch | null {
  let best: SpeakerMatch | null = null;
  for (const [personId, confidence] of byPerson) {
    if (!best || confidence > best.confidence) best = { personId, confidence };
  }
  return best && best.confidence >= minConfidence ? best : null;
}

/**
 * Suggests people for a recording's speakers from the voiceprint library as it
 * stands now, not as it stood when the recording was processed.
 *
 * Processing identifies speakers only against voiceprints that already exist,
 * and only for the people named at upload. Upload a batch of recordings, map
 * the speakers of the first one — which is what creates those people's
 * voiceprints — and every other recording of the batch is already sitting in
 * `awaiting_mapping` without a suggestion. This closes that gap when such a
 * recording is opened. A completed recording gets the same on request, for the
 * speakers it was confirmed with no one assigned to.
 *
 * It compares the per-speaker sample clips (at most 30s each, already in
 * storage), not the whole recording: the speakers and their numbering stay
 * exactly as the transcript has them, and the cost is one short clip per
 * speaker instead of re-processing hours of audio. Results land in the same
 * `suggestedPersonId` / `suggestedConfidence` the mapping screen pre-fills
 * from. They are suggestions only — confirming stays with the user.
 *
 * Runs are fire-and-forget and tracked in memory, like the pipeline itself. A
 * restart mid-run loses only that run, and the next open starts it again,
 * because the checked voiceprints are recorded only when a result is written.
 */
@Injectable()
export class SpeakerIdentificationService {
  private readonly logger = new Logger(SpeakerIdentificationService.name);
  private readonly runs = new Map<number, RunState>();

  constructor(
    @InjectRepository(Transcription)
    private readonly transcriptionRepo: Repository<Transcription>,
    private readonly personService: PersonService,
    private readonly pyannote: PyannoteService,
    private readonly fileService: FileService,
  ) {}

  /**
   * Start matching this recording's unassigned speakers against the library,
   * unless there is nothing new to compare them with. Returns immediately;
   * progress is reported through `getState`.
   */
  async start(id: number): Promise<IdentifyStartResult> {
    this.prune();
    if (this.runs.get(id)?.status === 'processing') {
      return {
        started: false,
        reason: 'running',
        message: 'شناسایی گویندگان این رونویسی در حال اجراست',
        ...this.getState(id),
      };
    }

    // Claim the slot before the first await, so two quick opens of the same
    // recording can't both plan — and pay for — the same run.
    const previous = this.runs.get(id);
    this.setRun(id, 'processing', 'در حال بررسی گویندگان...');

    let plan: IdentifyPlan | IdentifySkip;
    try {
      plan = await this.plan(id);
    } catch (error) {
      this.restore(id, previous);
      throw error;
    }
    if ('reason' in plan) {
      this.restore(id, previous);
      return {
        started: false,
        reason: plan.reason,
        message: plan.message,
        ...this.getState(id),
      };
    }

    this.setRun(
      id,
      'processing',
      `در حال شناسایی ${plan.samples.length} گوینده با اثر صوتی افراد...`,
    );
    this.run(id, plan).catch((error: unknown) => {
      // run() records its own outcome; this only catches a failure in doing so.
      this.logger.error(`[Identify ${id}] crashed: ${errorMessage(error)}`);
      this.setRun(
        id,
        'failed',
        `شناسایی خودکار گویندگان ناموفق بود: ${errorMessage(error)}`,
      );
    });

    return { started: true, ...this.getState(id) };
  }

  /**
   * Drop the latest run's outcome: the recording's samples are about to be
   * rebuilt, and "2 of 3 speakers found" would describe clips that are gone. A
   * run still in flight keeps its slot; what it found is discarded when it
   * tries to write it (see `writeSuggestions`).
   */
  forget(id: number): void {
    if (this.runs.get(id)?.status !== 'processing') this.runs.delete(id);
  }

  /** The latest run's outcome, while it is fresh enough to be worth showing. */
  getState(id: number): SpeakerIdentifyState {
    const state = this.runs.get(id);
    if (!state || this.isStale(state)) {
      return { speaker_identify_status: null, speaker_identify_message: null };
    }
    return {
      speaker_identify_status: state.status,
      speaker_identify_message: state.message,
    };
  }

  // ---------------------------------------------------------------------------

  /**
   * Decide what a run would do, or why it would do nothing: the recording has
   * no speakers to match yet, every speaker already has a person or a
   * confident suggestion, the library is empty, or every open speaker was
   * already compared with every current voiceprint.
   */
  private async plan(id: number): Promise<IdentifyPlan | IdentifySkip> {
    const t = await this.transcriptionRepo
      .createQueryBuilder('t')
      .select([
        't.id',
        't.status',
        't.project_id',
        't.speaker_samples',
        't.speaker_map',
        't.expected_person_ids',
      ])
      .where('t.id = :id', { id })
      .getOne();
    if (!t) throw new HttpException('رونویسی یافت نشد', 404);

    if (!IDENTIFIABLE.includes(t.status)) {
      return skip(
        'not_ready',
        'این رونویسی هنوز به مرحله تطبیق گویندگان نرسیده است',
      );
    }
    if (!this.pyannote.isConfigured()) {
      return skip(
        'not_configured',
        'سرویس شناسایی گوینده (pyannote) تنظیم نشده است',
      );
    }

    const withClip = (t.speaker_samples ?? []).filter(
      (sample) => !!sample.audioPath,
    );
    if (withClip.length === 0) {
      return skip('no_samples', 'این رونویسی نمونه صدای گوینده ندارد');
    }

    // Only speakers nobody has decided on. A person assigned to a speaker is
    // the user's answer, and is not second-guessed.
    const open = withClip.filter(
      (sample) =>
        t.speaker_map?.[sample.speakerId] == null && !isConfident(sample),
    );
    if (open.length === 0) {
      return skip(
        'all_assigned',
        'همه گوینده‌ها شخص یا پیشنهاد مطمئن دارند؛ چیزی برای تطبیق نمانده است',
      );
    }

    const preferred = [
      ...(t.expected_person_ids ?? []),
      ...(await this.projectPeople(t)),
    ];
    const candidates = await this.personService.getVoiceprintCandidates(
      preferred,
      MAX_VOICEPRINTS,
    );
    if (candidates.length === 0) {
      return skip(
        'no_voiceprints',
        'هنوز هیچ شخصی اثر صوتی ندارد؛ با تأیید گویندگان یک رونویسی، اثر صوتی آن افراد ساخته می‌شود',
      );
    }

    const fingerprints = candidates.map((c) => `${c.personId}:${c.version}`);
    const samples = open.filter((sample) => {
      const checked = new Set(sample.voiceprintsChecked ?? []);
      return fingerprints.some((f) => !checked.has(f));
    });
    if (samples.length === 0) {
      return skip(
        'up_to_date',
        'گوینده‌های بی‌نام قبلاً با همه اثرهای صوتی فعلی مقایسه شده‌اند و تطبیق مطمئنی نداشتند',
      );
    }

    return { samples, candidates, fingerprints };
  }

  /**
   * People already mapped in the project's other recordings, most recent
   * first — the likeliest to be in this one too, so they are the last to be
   * left out when the library outgrows one identify job.
   */
  private async projectPeople(t: Transcription): Promise<number[]> {
    if (!t.project_id) return [];

    const rows = await this.transcriptionRepo
      .createQueryBuilder('t')
      .select(['t.id', 't.speaker_map', 't.updated_at'])
      .where('t.project_id = :projectId', { projectId: t.project_id })
      .andWhere('t.id <> :id', { id: t.id })
      .andWhere('t.speaker_map IS NOT NULL')
      .orderBy('t.updated_at', 'DESC')
      .getMany();

    const ids = new Set<number>();
    for (const row of rows) {
      for (const personId of Object.values(row.speaker_map ?? {})) {
        if (personId != null) ids.add(personId);
      }
    }
    return [...ids];
  }

  private async run(id: number, plan: IdentifyPlan): Promise<void> {
    this.logger.log(
      `[Identify ${id}] ${plan.samples.length} speaker(s) against ${plan.candidates.length} voiceprint(s)`,
    );

    // Only what pyannote expects — the extra candidate fields stay here.
    const voiceprints: PyannoteVoiceprintInput[] = plan.candidates.map(
      ({ label, voiceprint }) => ({ label, voiceprint }),
    );

    // Per checked speaker: its suggestion, or null when no one matched well.
    const results = new Map<string, SampleResult>();
    const errors: string[] = [];
    const queue = [...plan.samples];
    const worker = async () => {
      for (let sample = queue.shift(); sample; sample = queue.shift()) {
        try {
          const byPerson = await this.scoreSample(sample, voiceprints);
          results.set(sample.speakerId, {
            audioPath: sample.audioPath,
            match: bestMatch(byPerson, MIN_MATCH_CONFIDENCE),
          });
          this.logger.log(
            `[Identify ${id}] ${sample.speakerId}: ${this.describeScores(byPerson)}`,
          );
        } catch (error) {
          errors.push(errorMessage(error));
          this.logger.warn(
            `[Identify ${id}] ${sample.speakerId} failed: ${errorMessage(error)}`,
          );
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () =>
        worker(),
      ),
    );

    const written =
      results.size > 0 && (await this.writeSuggestions(id, plan, results));
    const matched = written
      ? [...results.values()].filter((result) => result.match !== null).length
      : 0;

    if (errors.length > 0) {
      this.setRun(
        id,
        'failed',
        results.size > 0
          ? `شناسایی خودکار: ${matched} از ${results.size} گوینده پیدا شد، ولی بررسی ${errors.length} گوینده ناموفق بود (${errors[0]})`
          : `شناسایی خودکار گویندگان ناموفق بود: ${errors[0]}`,
      );
    } else if (!written) {
      // The recording moved on while pyannote was working (a re-run rebuilt
      // its samples, say) — these results belong to clips that are gone.
      this.setRun(id, 'done', null);
    } else if (matched > 0) {
      this.setRun(
        id,
        'done',
        `شناسایی خودکار: ${matched} از ${results.size} گوینده با اثر صوتی افراد پیدا شد.`,
      );
    } else {
      this.setRun(
        id,
        'done',
        'شناسایی خودکار: هیچ‌کدام از گوینده‌ها با اثر صوتی افراد کتابخانه تطبیق پیدا نکرد.',
      );
    }
    this.logger.log(
      `[Identify ${id}] done: ${matched} matched, ${errors.length} failed`,
    );
  }

  /**
   * Pyannote's confidence, per candidate person, that the sample's voice is
   * theirs. A clip is chosen for holding as little of the other speakers as
   * possible, but a stray interjection can still come back as a second speaker
   * of the clip — so the scores are taken from whoever talks most in it.
   */
  private async scoreSample(
    sample: SpeakerSample,
    voiceprints: PyannoteVoiceprintInput[],
  ): Promise<Map<number, number>> {
    const url = await this.fileService.getPresignedUrl(
      sample.audioPath,
      CLIP_URL_TTL,
    );
    const { diarization, matches } = await this.pyannote.identifySpeakers(
      url,
      voiceprints,
      { threshold: 0, exclusive: true },
    );

    const talk = new Map<string, number>();
    for (const seg of diarization) {
      talk.set(
        seg.speaker,
        (talk.get(seg.speaker) ?? 0) + Math.max(0, seg.end - seg.start),
      );
    }
    const dominant = [...talk.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const summary = matches.find((m) => m.speaker === dominant) ?? matches[0];

    const byPerson = new Map<number, number>();
    for (const [label, confidence] of Object.entries(
      summary?.confidence ?? {},
    )) {
      const personId = parseInt(label, 10);
      if (!Number.isNaN(personId) && typeof confidence === 'number') {
        byPerson.set(personId, confidence);
      }
    }
    return byPerson;
  }

  /**
   * Merge the run into the row as it is now, not as it was when planned:
   * pyannote takes a while and `speaker_samples` is written whole. Two things
   * may have happened meanwhile, and both are checked:
   *
   * - the pipeline ran again (`reprocess`) and rebuilt the samples. A rebuilt
   *   sample can reuse the speaker id but not the clip, so results are applied
   *   only to the clip they were scored on;
   * - the row left the mapping stage — the status is part of the UPDATE's own
   *   condition, so a re-run claiming the row between the read and the write
   *   makes the write a no-op instead of putting old samples back.
   */
  private async writeSuggestions(
    id: number,
    plan: IdentifyPlan,
    results: Map<string, SampleResult>,
  ): Promise<boolean> {
    const fresh = await this.transcriptionRepo
      .createQueryBuilder('t')
      .select(['t.id', 't.status', 't.speaker_samples'])
      .where('t.id = :id', { id })
      .getOne();
    if (!fresh || !IDENTIFIABLE.includes(fresh.status)) return false;

    let applied = 0;
    const samples = (fresh.speaker_samples ?? []).map((sample) => {
      const result = results.get(sample.speakerId);
      if (!result || result.audioPath !== sample.audioPath) return sample;
      applied += 1;
      return {
        ...sample,
        voiceprintsChecked: plan.fingerprints,
        // No good match leaves an earlier (weak) processing-time guess alone:
        // it came from the whole recording, and the screen shows its score.
        ...(result.match && {
          suggestedPersonId: result.match.personId,
          suggestedConfidence: result.match.confidence,
        }),
      };
    });
    if (applied === 0) return false;

    const update = await this.transcriptionRepo.update(
      { id, status: In(IDENTIFIABLE) },
      { speaker_samples: samples },
    );
    return (update.affected ?? 0) > 0;
  }

  /** The top three scores, for tuning the threshold from the logs. */
  private describeScores(byPerson: Map<number, number>): string {
    const top = [...byPerson.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([personId, confidence]) => `person ${personId}=${confidence}`);
    return top.length ? top.join(', ') : 'no scores';
  }

  private setRun(
    id: number,
    status: SpeakerIdentifyStatus,
    message: string | null,
  ): void {
    this.runs.set(id, { status, message, at: Date.now() });
  }

  private restore(id: number, previous: RunState | undefined): void {
    if (previous) this.runs.set(id, previous);
    else this.runs.delete(id);
  }

  private isStale(state: RunState): boolean {
    return (
      state.status !== 'processing' && Date.now() - state.at > STATE_TTL_MS
    );
  }

  private prune(): void {
    for (const [id, state] of this.runs) {
      if (this.isStale(state)) this.runs.delete(id);
    }
  }
}
