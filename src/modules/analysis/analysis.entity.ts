import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseTimestampEntity } from '../../common/abstracts/base.entity';
import { Project } from '../project/project.entity';
import { Transcription } from '../transcription/transcription.entity';

/**
 * How the body of an analysis should be rendered. LLM output is usually
 * Markdown, but structured extractions arrive as JSON and some tools produce
 * HTML or plain text.
 */
export enum AnalysisFormat {
  MARKDOWN = 'markdown',
  TEXT = 'text',
  HTML = 'html',
  JSON = 'json',
}

export const ANALYSIS_FORMATS = Object.values(AnalysisFormat);

/**
 * One analysis of one recording — a document produced elsewhere (typically by
 * an LLM) and filed against the transcript so it can be read next to it later.
 *
 * A recording accumulates several of these, each covering a different angle:
 * its profile, a full evidence extraction, a structured rewrite, a
 * cross-source validation, and so on. The angle is `kind`, taken from the
 * project's own analysis taxonomy so it can be extended per project.
 */
@Entity('transcript_analyses')
export class TranscriptAnalysis extends BaseTimestampEntity {
  @Column({ type: 'int' })
  @Index()
  transcription_id: number;
  @ManyToOne(() => Transcription, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'transcription_id' })
  transcription?: Transcription;

  /**
   * Copied from the transcription at creation time. Denormalized on purpose:
   * it lets the project taxonomy count how often each analysis kind is used,
   * and survives the recording being re-filed.
   */
  @Column({ type: 'int', nullable: true })
  @Index()
  project_id?: number | null;
  @ManyToOne(() => Project, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'project_id' })
  project?: Project | null;

  /** Key from the project's `analysis` taxonomy (nullable for unfiled voices). */
  @Column({ type: 'varchar', length: 64, nullable: true })
  kind?: string | null;

  @Column({ length: 255 })
  title: string;

  /** What this analysis is and how it was produced. */
  @Column({ type: 'text', nullable: true })
  description?: string | null;

  @Column({ type: 'varchar', length: 16, default: AnalysisFormat.MARKDOWN })
  format: AnalysisFormat;

  /** The document itself, verbatim. */
  @Column({ type: 'text' })
  content: string;

  /** Which model / tool produced it, e.g. "Gemini 2.5 Pro". */
  @Column({ type: 'varchar', length: 255, nullable: true })
  source?: string | null;

  @Column({ type: 'jsonb', nullable: true })
  tags?: string[] | null;

  /** Pinned analyses sort first — e.g. the recording's profile. */
  @Column({ default: false })
  pinned: boolean;
}
