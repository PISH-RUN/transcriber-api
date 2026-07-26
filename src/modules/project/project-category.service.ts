import { HttpException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ProjectCategory,
  ProjectCategoryKind,
} from './project-category.entity';
import { defaultsFor, usageSourceFor } from './project-category.defaults';
import {
  CreateProjectCategoryDto,
  UpdateProjectCategoryDto,
} from './project-category.dto';

const NOT_FOUND = 'دسته‌بندی یافت نشد';

@Injectable()
export class ProjectCategoryService {
  private readonly logger = new Logger(ProjectCategoryService.name);

  constructor(
    @InjectRepository(ProjectCategory)
    private readonly categoryRepo: Repository<ProjectCategory>,
  ) {}

  /**
   * The project's taxonomy for one kind, seeded from the defaults on first
   * access so a brand-new project is immediately usable.
   */
  async list(
    projectId: number,
    kind: ProjectCategoryKind,
  ): Promise<ProjectCategory[]> {
    await this.ensureSeeded(projectId, kind);

    const categories = await this.categoryRepo.find({
      where: { project_id: projectId, kind },
      order: { sort_order: 'ASC', id: 'ASC' },
    });

    const usage = await this.usageCounts(projectId, kind);
    return categories.map((category) => ({
      ...category,
      usage_count: usage.get(category.key) ?? 0,
    }));
  }

  /** Every taxonomy at once, for the project settings screen. */
  async listAll(projectId: number): Promise<{
    glossary: ProjectCategory[];
    evidence: ProjectCategory[];
    analysis: ProjectCategory[];
  }> {
    return {
      glossary: await this.list(projectId, ProjectCategoryKind.GLOSSARY),
      evidence: await this.list(projectId, ProjectCategoryKind.EVIDENCE),
      analysis: await this.list(projectId, ProjectCategoryKind.ANALYSIS),
    };
  }

  async create(dto: CreateProjectCategoryDto): Promise<ProjectCategory> {
    const label = dto.label.trim();
    if (!label) throw new HttpException('عنوان دسته‌بندی خالی است', 400);

    await this.ensureSeeded(dto.project_id, dto.kind);

    const existingLabel = await this.categoryRepo
      .createQueryBuilder('c')
      .where('c.project_id = :projectId', { projectId: dto.project_id })
      .andWhere('c.kind = :kind', { kind: dto.kind })
      .andWhere('LOWER(TRIM(c.label)) = LOWER(:label)', { label })
      .getOne();
    if (existingLabel) {
      throw new HttpException('دسته‌بندی با این عنوان وجود دارد', 409);
    }

    const last = await this.categoryRepo.findOne({
      where: { project_id: dto.project_id, kind: dto.kind },
      order: { sort_order: 'DESC' },
    });

    return this.categoryRepo.save(
      this.categoryRepo.create({
        project_id: dto.project_id,
        kind: dto.kind,
        key: await this.buildKey(dto.project_id, dto.kind, label),
        label,
        color: dto.color ?? null,
        sort_order: (last?.sort_order ?? 0) + 1,
        is_default: false,
      }),
    );
  }

  /**
   * Only presentation can change: `key` is referenced by existing terms and
   * evidence items, so renaming a category never breaks what already points at
   * it.
   */
  async update(
    id: number,
    dto: UpdateProjectCategoryDto,
  ): Promise<ProjectCategory> {
    const category = await this.categoryRepo.findOne({ where: { id } });
    if (!category) throw new HttpException(NOT_FOUND, 404);

    if (dto.label !== undefined) {
      const label = dto.label.trim();
      if (!label) throw new HttpException('عنوان دسته‌بندی خالی است', 400);
      const clash = await this.categoryRepo
        .createQueryBuilder('c')
        .where('c.project_id = :projectId', { projectId: category.project_id })
        .andWhere('c.kind = :kind', { kind: category.kind })
        .andWhere('LOWER(TRIM(c.label)) = LOWER(:label)', { label })
        .andWhere('c.id != :id', { id })
        .getOne();
      if (clash)
        throw new HttpException('دسته‌بندی با این عنوان وجود دارد', 409);
      category.label = label;
    }
    if (dto.color !== undefined) category.color = dto.color ?? null;
    if (dto.sort_order !== undefined) category.sort_order = dto.sort_order;

    return this.categoryRepo.save(category);
  }

  /**
   * A category in use is not removable: dropping it would leave terms and
   * evidence pointing at something that no longer exists. The error carries the
   * count so the UI can say exactly what blocks it.
   */
  async remove(id: number): Promise<{ success: boolean }> {
    const category = await this.categoryRepo.findOne({ where: { id } });
    if (!category) throw new HttpException(NOT_FOUND, 404);

    const usage = await this.usageCounts(category.project_id, category.kind);
    const count = usage.get(category.key) ?? 0;
    if (count > 0) {
      throw new HttpException(
        `این دسته‌بندی روی ${count} مورد استفاده شده است؛ ابتدا آن‌ها را به دسته‌بندی دیگری منتقل کنید.`,
        409,
      );
    }

    await this.categoryRepo.remove(category);
    return { success: true };
  }

  /**
   * Guard used by the glossary/evidence services: a term may only carry a
   * category that its own project defines.
   */
  async assertValid(
    projectId: number,
    kind: ProjectCategoryKind,
    key: string,
  ): Promise<void> {
    await this.ensureSeeded(projectId, kind);
    const found = await this.categoryRepo.findOne({
      where: { project_id: projectId, kind, key },
    });
    if (!found) {
      throw new HttpException('این دسته‌بندی در این پروژه تعریف نشده است', 400);
    }
  }

  // ---------------------------------------------------------------------------

  private async ensureSeeded(
    projectId: number,
    kind: ProjectCategoryKind,
  ): Promise<void> {
    const existing = await this.categoryRepo.count({
      where: { project_id: projectId, kind },
    });
    if (existing > 0) return;

    const rows = defaultsFor(kind).map((item, index) =>
      this.categoryRepo.create({
        project_id: projectId,
        kind,
        key: item.key,
        label: item.label,
        color: item.color,
        sort_order: index,
        is_default: true,
      }),
    );

    // Two parallel first-reads could both try to seed; the unique index makes
    // the loser a no-op rather than an error the user would see.
    try {
      await this.categoryRepo.save(rows);
      this.logger.log(
        `Seeded ${rows.length} default ${kind} categories for project ${projectId}`,
      );
    } catch (error: any) {
      this.logger.warn(
        `Seeding ${kind} categories for project ${projectId} skipped: ${error?.message}`,
      );
    }
  }

  private async usageCounts(
    projectId: number,
    kind: ProjectCategoryKind,
  ): Promise<Map<string, number>> {
    const { table, column } = usageSourceFor(kind);
    const rows: Array<{ key: string; count: string }> =
      await this.categoryRepo.query(
        `SELECT ${column} AS key, COUNT(*) AS count FROM ${table} WHERE project_id = $1 GROUP BY ${column}`,
        [projectId],
      );
    return new Map(rows.map((row) => [row.key, Number(row.count)]));
  }

  /**
   * Build a stable key. Persian labels don't slugify usefully, so a custom
   * category gets an opaque generated key; only its label is ever shown.
   */
  private async buildKey(
    projectId: number,
    kind: ProjectCategoryKind,
    label: string,
  ): Promise<string> {
    const slug = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40);

    const base = slug || `c${Date.now().toString(36)}`;
    let candidate = base;
    let suffix = 2;

    // eslint-disable-next-line no-await-in-loop
    while (
      await this.categoryRepo.findOne({
        where: { project_id: projectId, kind, key: candidate },
      })
    ) {
      candidate = `${base}_${suffix}`;
      suffix += 1;
    }

    return candidate;
  }
}
