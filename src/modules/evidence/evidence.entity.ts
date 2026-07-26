import { Column, Entity, Index, JoinColumn, ManyToOne, Unique } from 'typeorm';
import { BaseTimestampEntity } from '../../common/abstracts/base.entity';
import { Project } from '../project/project.entity';
import { GlossaryTerm } from '../glossary/glossary.entity';
import { Transcription } from '../transcription/transcription.entity';

/**
 * A quote lifted out of a transcript into the project's evidence basket.
 *
 * The quote text is stored, not just a pointer: the basket is project-level
 * knowledge and has to stay readable even if the source recording is later
 * deleted (`transcription_id` is then set to null, and `source_title` keeps
 * the provenance).
 */
@Entity('evidence_items')
export class EvidenceItem extends BaseTimestampEntity {
  @Column({ type: 'int' })
  @Index()
  project_id: number;
  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project?: Project;

  @Column({ type: 'int', nullable: true })
  @Index()
  transcription_id?: number | null;
  @ManyToOne(() => Transcription, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'transcription_id' })
  transcription?: Transcription | null;

  /** Title of the recording at capture time — survives its deletion. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  source_title?: string | null;

  /**
   * Key of an evidence type in this project's own taxonomy (see
   * ProjectCategory). Free text for the same reason as GlossaryTerm.category:
   * projects can define their own types.
   */
  @Column({ type: 'varchar', length: 64 })
  type: string;

  /** Short headline for the passage, e.g. "گستره صادرات". */
  @Column({ type: 'varchar', length: 255, nullable: true })
  title?: string | null;

  /**
   * Where the reviewer's confidence stands: "لازم" (needs checking), "سند",
   * "مصاحبه-دیگر", … Free text, taken from the reviewer's own vocabulary.
   */
  @Column({ type: 'varchar', length: 128, nullable: true })
  verification?: string | null;

  /** The selected passage, verbatim. */
  @Column({ type: 'text' })
  quote: string;

  /** The reviewer's own note about why this matters. */
  @Column({ type: 'text', nullable: true })
  note?: string | null;

  @Column({ type: 'jsonb', nullable: true })
  tags?: string[] | null;

  /** First line of the passage. */
  @Column({ type: 'int', nullable: true })
  segment_index?: number | null;

  /**
   * Last line, when the passage spans several speaker turns. A reviewer often
   * marks a stretch of conversation ("from here … to there"), not one line.
   */
  @Column({ type: 'int', nullable: true })
  end_segment_index?: number | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  speaker_label?: string | null;

  @Column({ type: 'int', nullable: true })
  start_ms?: number | null;

  @Column({ type: 'int', nullable: true })
  end_ms?: number | null;

  /**
   * False when the quote could not be located in the transcript on import, so
   * the UI can single those out for manual placement instead of pretending the
   * pointer is good.
   */
  @Column({ default: true })
  anchored: boolean;

  // --- analytical metadata -------------------------------------------------

  /**
   * A neutral one-sentence summary of what the quote supports, phrased as a
   * claim of the speaker rather than an established fact. Distinct from `note`,
   * which is why the item is worth keeping.
   */
  @Column({ type: 'text', nullable: true })
  claim_summary?: string | null;

  /** 3–5. A real column because the basket is browsed by importance. */
  @Column({ type: 'int', nullable: true })
  importance?: number | null;

  /** Confidence that the quote is correctly located and worth keeping, 0–1. */
  @Column({ type: 'float', nullable: true })
  confidence?: number | null;

  /**
   * How carefully this item has to be handled: `normal`, `internal`,
   * `sensitive_personnel`, `sensitive_financial`, `sensitive_legal`,
   * `sensitive_commercial`. Free-form varchar for the same reason as `type`.
   */
  @Column({ type: 'varchar', length: 32, nullable: true })
  sensitivity?: string | null;

  /** Does the claim need checking against data, a document or another person? */
  @Column({ default: false })
  requires_validation: boolean;

  /** How to check it: `document`, `system_data`, `another_interview`, … */
  @Column({ type: 'jsonb', nullable: true })
  validation_methods?: string[] | null;

  /** Which other account this is worth comparing against, and on what. */
  @Column({ type: 'text', nullable: true })
  comparison_potential?: string | null;

  /** The speaker attributed the information to someone else. */
  @Column({ default: false })
  quoted_from_another_person: boolean;

  /** People explicitly named inside the quote. */
  @Column({ type: 'jsonb', nullable: true })
  referenced_people?: string[] | null;

  /** Whether the passage includes interviewer speech, not only the answer. */
  @Column({ default: false })
  contains_interviewer_text: boolean;

  /** Hand-picked, bulk-imported, or proposed by an AI extraction run. */
  @Column({ type: 'varchar', length: 16, default: 'manual' })
  origin: 'manual' | 'import' | 'ai';

  /** Whatever an extraction run returned that has no column of its own. */
  @Column({ type: 'jsonb', nullable: true })
  ai_meta?: Record<string, unknown> | null;

  /** Not a column: glossary terms linked to this item, filled by the service. */
  terms?: Array<{ id: number; term: string; category: string }>;
}

/**
 * Which glossary terms a piece of evidence is about.
 *
 * A real link table rather than a list of names on the item: the point is to
 * open a term and see the evidence that mentions it, which a text tag cannot
 * answer, and renaming a term must not break the connection.
 */
@Entity('evidence_term_links')
@Unique('uq_evidence_term', ['evidence_id', 'term_id'])
export class EvidenceTermLink extends BaseTimestampEntity {
  @Column({ type: 'int' })
  @Index()
  evidence_id: number;
  @ManyToOne(() => EvidenceItem, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'evidence_id' })
  evidence?: EvidenceItem;

  @Column({ type: 'int' })
  @Index()
  term_id: number;
  @ManyToOne(() => GlossaryTerm, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'term_id' })
  term?: GlossaryTerm;
}
