import { Column, Entity, Index, JoinColumn, ManyToOne, Unique } from 'typeorm';
import { BaseTimestampEntity } from '../../common/abstracts/base.entity';
import { Project } from '../project/project.entity';
import { Transcription } from '../transcription/transcription.entity';

export enum ExtractionKind {
  /** "واژه‌یابی" — propose new glossary terms. */
  GLOSSARY = 'glossary',
  /** "شواهد‌یابی" — propose evidence items. */
  EVIDENCE = 'evidence',
}

export enum ExtractionStatus {
  PROCESSING = 'processing',
  DONE = 'done',
  FAILED = 'failed',
}

/**
 * One execution of an AI extraction over a transcript.
 *
 * The run is a row rather than a request/response pair because a two-hour
 * interview takes minutes: the button has to return immediately, the wizard has
 * to survive a closed dialog or a page reload, and the reviewer has to be able
 * to come back to candidates they did not finish triaging.
 *
 * `candidates` holds the model's proposals exactly as parsed, each with the
 * verification our own code added (was the quote actually found in the text?)
 * and its triage state. Nothing is written into the glossary or the basket until
 * the reviewer applies the run.
 */
@Entity('ai_extraction_runs')
export class AiExtractionRun extends BaseTimestampEntity {
  @Column({ type: 'int' })
  @Index()
  transcription_id: number;
  @ManyToOne(() => Transcription, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'transcription_id' })
  transcription?: Transcription;

  @Column({ type: 'int' })
  @Index()
  project_id: number;
  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project?: Project;

  @Column({ type: 'varchar', length: 16 })
  kind: ExtractionKind;

  @Column({ type: 'varchar', length: 16, default: ExtractionStatus.PROCESSING })
  status: ExtractionStatus;

  /** Progress or failure text, shown verbatim in the UI. */
  @Column({ type: 'varchar', length: 512, nullable: true })
  message?: string | null;

  /** Which model produced this, so an old run stays interpretable. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  model?: string | null;

  /**
   * Parsed candidates. Shape depends on `kind`; both carry `candidate_id`,
   * `decision` ('pending' | 'accepted' | 'rejected') and the anchoring result.
   */
  @Column({ type: 'jsonb', nullable: true })
  candidates?: Array<Record<string, any>> | null;

  /** Transcript-wide problems the model reported. */
  @Column({ type: 'jsonb', nullable: true })
  warnings?: string[] | null;

  /** Evidence runs only: the model's own account of what it covered. */
  @Column({ type: 'jsonb', nullable: true })
  coverage?: Record<string, unknown> | null;

  /**
   * Evidence runs only: what kind of session this was (`interview`,
   * `presentation_and_discussion`, …) plus a one-line description.
   *
   * Kept because a product pitch and a diagnostic interview must not be read the
   * same way months later, when nobody remembers which this was.
   */
  @Column({ type: 'jsonb', nullable: true })
  source_characterization?: Record<string, unknown> | null;

  @Column({ type: 'int', default: 0 })
  accepted_count: number;

  @Column({ type: 'int', default: 0 })
  rejected_count: number;

  @Column({ type: 'timestamp', nullable: true })
  applied_at?: Date | null;

  // --- diagnostics ---------------------------------------------------------
  // Kept because extraction is the one place where a silent truncation looks
  // exactly like "the model found nothing", and these three numbers tell them
  // apart without re-running the call.

  @Column({ type: 'int', nullable: true })
  prompt_chars?: number | null;

  @Column({ type: 'int', nullable: true })
  response_chars?: number | null;

  @Column({ type: 'int', nullable: true })
  duration_ms?: number | null;
}

/**
 * A candidate the reviewer turned down.
 *
 * Without this, pressing the button a second time proposes the same rejected
 * items again — the model has no memory of the conversation. Rejections are fed
 * back into the next run, so the second press is about what is genuinely new.
 */
@Entity('ai_candidate_rejections')
@Unique('uq_rejection_per_project', ['project_id', 'kind', 'fingerprint'])
export class AiCandidateRejection extends BaseTimestampEntity {
  @Column({ type: 'int' })
  @Index()
  project_id: number;
  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project?: Project;

  /** Where it was proposed. Null once the recording is gone. */
  @Column({ type: 'int', nullable: true })
  transcription_id?: number | null;
  @ManyToOne(() => Transcription, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'transcription_id' })
  transcription?: Transcription | null;

  @Column({ type: 'varchar', length: 16 })
  kind: ExtractionKind;

  /**
   * Normalized identity of the candidate (Persian-normalized term, or the
   * opening of a normalized quote). Comparing normalized forms is what makes a
   * rejection stick when the model proposes the same thing spelled differently.
   */
  @Column({ type: 'varchar', length: 255 })
  fingerprint: string;

  /** Human-readable form, shown back to the model and to the reviewer. */
  @Column({ type: 'varchar', length: 512 })
  label: string;
}
