import { Column, Entity } from 'typeorm';
import { BaseTimestampEntity } from '../../common/abstracts/base.entity';

/**
 * A folder for transcriptions. Once an account accumulates dozens of
 * recordings, the project is the primary way to keep them apart — a
 * transcription may belong to at most one project, and deleting a project
 * leaves its transcriptions in place (unfiled) rather than destroying them.
 */
@Entity('projects')
export class Project extends BaseTimestampEntity {
  @Column({ length: 255 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  /**
   * Optional chip/avatar color for the UI. The type is explicit because a
   * `string | null` property reflects as `Object`, which TypeORM can't map.
   */
  @Column({ type: 'varchar', length: 32, nullable: true })
  color?: string | null;

  /** Not a column: filled in by the service for list views. */
  transcription_count?: number;
}
