import { Column, Entity, Index, JoinColumn, ManyToOne, Unique } from 'typeorm';
import { BaseTimestampEntity } from '../../common/abstracts/base.entity';
import { Project } from './project.entity';

/** Which taxonomy a category belongs to. */
export enum ProjectCategoryKind {
  GLOSSARY = 'glossary',
  EVIDENCE = 'evidence',
  ANALYSIS = 'analysis',
}

/**
 * A category of one project's taxonomy: a glossary category ("شرکت‌ها",
 * "سامانه‌ها", ...), an evidence type ("تصمیم", "مشکل", ...) or an analysis
 * kind ("شناسنامه ویس", "استخراج کامل شواهد", ...).
 *
 * Every project starts from the built-in defaults, which are copied into this
 * table the first time the taxonomy is read. From then on the project owns its
 * own list and can add, rename, recolor or remove entries: two projects on very
 * different subjects should not be forced to share one vocabulary.
 *
 * `key` is the stable identifier stored on terms and evidence items, so it is
 * immutable once created — only the presentation (`label`, `color`,
 * `sort_order`) can change.
 */
@Entity('project_categories')
@Unique('uq_project_category_key', ['project_id', 'kind', 'key'])
export class ProjectCategory extends BaseTimestampEntity {
  @Column({ type: 'int' })
  @Index()
  project_id: number;
  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project?: Project;

  @Column({ type: 'varchar', length: 16 })
  kind: ProjectCategoryKind;

  @Column({ type: 'varchar', length: 64 })
  key: string;

  @Column({ type: 'varchar', length: 255 })
  label: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  color?: string | null;

  @Column({ type: 'int', default: 0 })
  sort_order: number;

  /** True for the entries seeded from the built-in defaults. */
  @Column({ default: false })
  is_default: boolean;

  /** Not a column: how many terms / evidence items currently use this key. */
  usage_count?: number;
}
