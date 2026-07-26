import { HttpException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Project } from './project.entity';
import { CreateProjectDto, UpdateProjectDto } from './project.dto';

const NOT_FOUND = 'پروژه یافت نشد';

@Injectable()
export class ProjectService {
  constructor(
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
  ) {}

  /** All projects, each carrying how many transcriptions are filed under it. */
  async findAll(): Promise<Project[]> {
    const projects = await this.projectRepo.find({ order: { name: 'ASC' } });
    if (projects.length === 0) return [];

    // Counted with a separate grouped query instead of a relation, so the
    // Project entity stays free of a circular import to Transcription.
    const rows: Array<{ project_id: number; count: string }> =
      await this.projectRepo.query(
        'SELECT project_id, COUNT(*) AS count FROM transcriptions WHERE project_id IS NOT NULL GROUP BY project_id',
      );
    const counts = new Map(
      rows.map((row) => [Number(row.project_id), Number(row.count)]),
    );

    return projects.map((project) => ({
      ...project,
      transcription_count: counts.get(project.id) ?? 0,
    }));
  }

  async findById(id: number): Promise<Project> {
    const project = await this.projectRepo.findOne({ where: { id } });
    if (!project) throw new HttpException(NOT_FOUND, 404);
    return project;
  }

  async create(data: CreateProjectDto): Promise<Project> {
    const name = data.name.trim();
    const existing = await this.findByName(name);
    if (existing) {
      throw new HttpException('پروژه‌ای با این نام وجود دارد', 409);
    }
    return this.projectRepo.save(
      this.projectRepo.create({
        name,
        description: data.description ?? null,
        color: data.color ?? null,
      }),
    );
  }

  async update(id: number, data: UpdateProjectDto): Promise<Project> {
    const project = await this.findById(id);

    if (data.name !== undefined) {
      const name = data.name.trim();
      const clash = await this.findByName(name);
      if (clash && clash.id !== id) {
        throw new HttpException('پروژه‌ای با این نام وجود دارد', 409);
      }
      project.name = name;
    }
    if (data.description !== undefined) project.description = data.description;
    if (data.color !== undefined) project.color = data.color;

    return this.projectRepo.save(project);
  }

  /**
   * Deleting a project unfiles its transcriptions (`project_id` is SET NULL by
   * the FK) — recordings are never removed as a side effect.
   */
  async remove(id: number): Promise<{ success: boolean }> {
    const project = await this.findById(id);
    await this.projectRepo.remove(project);
    return { success: true };
  }

  /**
   * Used by the upload flow: the user can name a new project right in the
   * upload dialog instead of creating it up front.
   */
  async findOrCreateByName(name: string): Promise<Project> {
    const trimmed = name.trim();
    if (!trimmed) throw new HttpException('نام پروژه خالی است', 400);

    const existing = await this.findByName(trimmed);
    if (existing) return existing;

    return this.projectRepo.save(this.projectRepo.create({ name: trimmed }));
  }

  private findByName(name: string): Promise<Project | null> {
    return this.projectRepo
      .createQueryBuilder('p')
      .where('LOWER(TRIM(p.name)) = LOWER(:name)', { name: name.trim() })
      .getOne();
  }
}
