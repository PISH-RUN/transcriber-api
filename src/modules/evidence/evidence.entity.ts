import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseTimestampEntity } from '../../common/abstracts/base.entity';
import { Project } from '../project/project.entity';
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

  /** The selected passage, verbatim. */
  @Column({ type: 'text' })
  quote: string;

  /** The reviewer's own note about why this matters. */
  @Column({ type: 'text', nullable: true })
  note?: string | null;

  @Column({ type: 'jsonb', nullable: true })
  tags?: string[] | null;

  @Column({ type: 'int', nullable: true })
  segment_index?: number | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  speaker_label?: string | null;

  @Column({ type: 'int', nullable: true })
  start_ms?: number | null;
}
