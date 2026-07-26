import { Column, Entity, Index, JoinColumn, ManyToOne, Unique } from 'typeorm';
import { BaseTimestampEntity } from '../../common/abstracts/base.entity';
import { Project } from '../project/project.entity';
import { Transcription } from '../transcription/transcription.entity';

/**
 * A word or phrase that matters inside one project.
 *
 * The dictionary belongs to the project, not to a recording: it is built up
 * one selection at a time while reviewing transcripts, and from the second
 * recording onwards it is reused. `aliases` collects the other surface forms
 * the same concept appeared as (STT rarely spells a name the same way twice).
 */
@Entity('glossary_terms')
@Unique('uq_glossary_term_per_project', ['project_id', 'term'])
export class GlossaryTerm extends BaseTimestampEntity {
  @Column({ type: 'int' })
  @Index()
  project_id: number;
  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project?: Project;

  /** The canonical spelling. */
  @Column({ length: 255 })
  term: string;

  /**
   * Key of a category in this project's own taxonomy (see ProjectCategory).
   * Stored as free text rather than a database enum: each project may add its
   * own categories, so the set of valid values is per-project data, validated
   * on write instead of by the column type.
   */
  @Column({ type: 'varchar', length: 64 })
  category: string;

  /** Other spellings/forms seen in transcripts, used for highlighting. */
  @Column({ type: 'jsonb', nullable: true })
  aliases?: string[] | null;

  @Column({ type: 'jsonb', nullable: true })
  tags?: string[] | null;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  /**
   * How settled this entry is — "تأیید شده", "نیازمند تأیید", … Free text on
   * purpose: it comes straight from the reviewer's own working notes, and
   * constraining it would only get in the way. Filterable in the UI.
   */
  @Column({ type: 'varchar', length: 128, nullable: true })
  status?: string | null;

  // --- provenance and AI-extraction metadata -------------------------------

  /** Where this entry came from: hand-tagged, bulk import, or an AI run. */
  @Column({ type: 'varchar', length: 16, default: 'manual' })
  origin: 'manual' | 'import' | 'ai';

  /**
   * How central the term is to the project (3–5 as scored by extraction, or set
   * by hand). Kept as a real column because the panel sorts and filters on it.
   */
  @Column({ type: 'int', nullable: true })
  importance?: number | null;

  /** Extraction confidence, 0–1. Not a claim about the term being correct. */
  @Column({ type: 'float', nullable: true })
  confidence?: number | null;

  /** Flagged by extraction as needing a human decision (spelling, identity…). */
  @Column({ default: false })
  needs_review: boolean;

  /** Why it needs review, in the reviewer's own language. */
  @Column({ type: 'text', nullable: true })
  review_note?: string | null;

  /**
   * Anything an extraction run returned that has no column of its own. Kept so
   * a later prompt change never silently discards information we already paid
   * for; never read by business logic.
   */
  @Column({ type: 'jsonb', nullable: true })
  ai_meta?: Record<string, unknown> | null;

  /** Not a column: filled in by the service for list views. */
  mention_count?: number;
}

/**
 * One place in one transcript where a term was tagged. This is what makes a
 * term traceable across the recordings of a project.
 */
@Entity('glossary_mentions')
export class GlossaryMention extends BaseTimestampEntity {
  @Column({ type: 'int' })
  @Index()
  term_id: number;
  @ManyToOne(() => GlossaryTerm, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'term_id' })
  term?: GlossaryTerm;

  @Column({ type: 'int' })
  @Index()
  transcription_id: number;
  @ManyToOne(() => Transcription, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'transcription_id' })
  transcription?: Transcription;

  /** Index of the segment (speaker turn) the selection came from. */
  @Column({ type: 'int', nullable: true })
  segment_index?: number | null;

  /** Character offsets of the selection inside that segment's text. */
  @Column({ type: 'int', nullable: true })
  start_offset?: number | null;
  @Column({ type: 'int', nullable: true })
  end_offset?: number | null;

  /** Exactly what was selected — may differ from the canonical term. */
  @Column({ type: 'varchar', length: 512, nullable: true })
  surface?: string | null;

  /** Surrounding text, so the mention list is readable on its own. */
  @Column({ type: 'text', nullable: true })
  context?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  speaker_label?: string | null;

  @Column({ type: 'int', nullable: true })
  start_ms?: number | null;
}
