import { HttpException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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

interface IdentifyPlan {
  /** Samples to send to pyannote in this run. */
  samples: SpeakerSample[];
  /** Library voiceprints to compare them with. */
  candidates: VoiceprintCandidate[];
  /** `<personId>:<version>` of every candidate, recorded on each checked sample. */
  fingerprints: string[];
}

export interface SpeakerMatch {
  personId: number;
  confidence: number;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' && error ? error : 'نامشخص';
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
 * recording is opened.
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
  async start(
    id: number,
  ): Promise<SpeakerIdentifyState & { started: boolean }> {
    this.prune();
    if (this.runs.get(id)?.status === 'processing') {
      return { started: false, ...this.getState(id) };
    }

    // Claim the slot before the first await, so two quick opens of the same
    // recording can't both plan — and pay for — the same run.
    const previous = this.runs.get(id);
    this.setRun(id, 'processing', 'در حال بررسی گویندگان...');

    let plan: IdentifyPlan | null;
    try {
      plan = await this.plan(id);
    } catch (error) {
      this.restore(id, previous);
      throw error;
    }
    if (!plan) {
      this.restore(id, previous);
      return { started: false, ...this.getState(id) };
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
   * Decide what a run would do, or `null` when it would do nothing: the
   * recording is not awaiting mapping, every speaker already has a confident
   * suggestion, the library is empty, or every open speaker was already
   * compared with every current voiceprint.
   */
  private async plan(id: number): Promise<IdentifyPlan | null> {
    const t = await this.transcriptionRepo
      .createQueryBuilder('t')
      .select([
        't.id',
        't.status',
        't.project_id',
        't.speaker_samples',
        't.expected_person_ids',
      ])
      .where('t.id = :id', { id })
      .getOne();
    if (!t) throw new HttpException('رونویسی یافت نشد', 404);

    // Only speakers nobody has assigned yet. A confirmed mapping is the user's
    // answer, and is not second-guessed.
    if (t.status !== TranscriptionStatus.AWAITING_MAPPING) return null;
    if (!this.pyannote.isConfigured()) return null;

    const open = (t.speaker_samples ?? []).filter(
      (sample) => !!sample.audioPath && !isConfident(sample),
    );
    if (open.length === 0) return null;

    const preferred = [
      ...(t.expected_person_ids ?? []),
      ...(await this.projectPeople(t)),
    ];
    const candidates = await this.personService.getVoiceprintCandidates(
      preferred,
      MAX_VOICEPRINTS,
    );
    if (candidates.length === 0) return null;

    const fingerprints = candidates.map((c) => `${c.personId}:${c.version}`);
    const samples = open.filter((sample) => {
      const checked = new Set(sample.voiceprintsChecked ?? []);
      return fingerprints.some((f) => !checked.has(f));
    });
    if (samples.length === 0) return null;

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
    const results = new Map<string, SpeakerMatch | null>();
    const errors: string[] = [];
    const queue = [...plan.samples];
    const worker = async () => {
      for (let sample = queue.shift(); sample; sample = queue.shift()) {
        try {
          const byPerson = await this.scoreSample(sample, voiceprints);
          results.set(
            sample.speakerId,
            bestMatch(byPerson, MIN_MATCH_CONFIDENCE),
          );
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
      ? [...results.values()].filter((match) => match !== null).length
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
      // Confirmed while pyannote was working — there is nothing left to suggest.
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
   * pyannote takes a while, `speaker_samples` is written whole, and the user
   * may have confirmed the mapping in the meantime — then nothing is written.
   */
  private async writeSuggestions(
    id: number,
    plan: IdentifyPlan,
    results: Map<string, SpeakerMatch | null>,
  ): Promise<boolean> {
    const fresh = await this.transcriptionRepo
      .createQueryBuilder('t')
      .select(['t.id', 't.status', 't.speaker_samples'])
      .where('t.id = :id', { id })
      .getOne();
    if (!fresh || fresh.status !== TranscriptionStatus.AWAITING_MAPPING) {
      return false;
    }

    const samples = (fresh.speaker_samples ?? []).map((sample) => {
      if (!results.has(sample.speakerId)) return sample;
      const match = results.get(sample.speakerId);
      return {
        ...sample,
        voiceprintsChecked: plan.fingerprints,
        // No good match leaves an earlier (weak) processing-time guess alone:
        // it came from the whole recording, and the screen shows its score.
        ...(match && {
          suggestedPersonId: match.personId,
          suggestedConfidence: match.confidence,
        }),
      };
    });

    await this.transcriptionRepo.update(id, { speaker_samples: samples });
    return true;
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
