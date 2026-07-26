import { HttpException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AnalysisFormat, TranscriptAnalysis } from './analysis.entity';
import { CreateAnalysisDto, UpdateAnalysisDto } from './analysis.dto';
import { Transcription } from '../transcription/transcription.entity';
import { ProjectCategoryKind } from '../project/project-category.entity';
import { ProjectCategoryService } from '../project/project-category.service';

const NOT_FOUND = 'تحلیل یافت نشد';

export interface ListAnalysesFilter {
  transcriptionId?: number;
  projectId?: number;
  kinds?: string[];
  search?: string;
}

@Injectable()
export class AnalysisService {
  constructor(
    @InjectRepository(TranscriptAnalysis)
    private readonly analysisRepo: Repository<TranscriptAnalysis>,
    @InjectRepository(Transcription)
    private readonly transcriptionRepo: Repository<Transcription>,
    private readonly categoryService: ProjectCategoryService,
  ) {}

  /**
   * List analyses. The `content` column is excluded here: a long LLM document
   * per row would make the sidebar listing needlessly heavy, and the reader
   * fetches the one it opens.
   */
  async list(filter: ListAnalysesFilter): Promise<TranscriptAnalysis[]> {
    const query = this.analysisRepo
      .createQueryBuilder('a')
      .select([
        'a.id',
        'a.transcription_id',
        'a.project_id',
        'a.kind',
        'a.title',
        'a.description',
        'a.format',
        'a.source',
        'a.tags',
        'a.pinned',
        'a.created_at',
        'a.updated_at',
      ])
      // Cheap stand-in for "how long is this document", so the list can show it
      // without shipping the document itself.
      .addSelect('LENGTH(a.content)', 'content_length');

    if (filter.transcriptionId != null) {
      query.andWhere('a.transcription_id = :transcriptionId', {
        transcriptionId: filter.transcriptionId,
      });
    }
    if (filter.projectId != null) {
      query.andWhere('a.project_id = :projectId', {
        projectId: filter.projectId,
      });
    }
    if (filter.kinds?.length) {
      query.andWhere('a.kind IN (:...kinds)', { kinds: filter.kinds });
    }
    if (filter.search?.trim()) {
      query.andWhere(
        '(a.title ILIKE :q OR a.description ILIKE :q OR a.content ILIKE :q OR CAST(a.tags AS TEXT) ILIKE :q)',
        { q: `%${filter.search.trim()}%` },
      );
    }

    const { entities, raw } = await query
      .orderBy('a.pinned', 'DESC')
      .addOrderBy('a.created_at', 'DESC')
      .getRawAndEntities();

    return entities.map((entity, index) => ({
      ...entity,
      content_length: Number(raw[index]?.content_length ?? 0),
    })) as TranscriptAnalysis[];
  }

  async findById(id: number): Promise<TranscriptAnalysis> {
    const analysis = await this.analysisRepo.findOne({ where: { id } });
    if (!analysis) throw new HttpException(NOT_FOUND, 404);
    return analysis;
  }

  async create(dto: CreateAnalysisDto): Promise<TranscriptAnalysis> {
    const content = dto.content?.trim();
    if (!content) throw new HttpException('متن تحلیل خالی است', 400);

    const source = await this.transcriptionRepo
      .createQueryBuilder('t')
      .select(['t.id', 't.project_id'])
      .where('t.id = :id', { id: dto.transcription_id })
      .getOne();
    if (!source) throw new HttpException('رونویسی یافت نشد', 404);

    const projectId = source.project_id ?? null;
    const kind = dto.kind?.trim() || null;

    // The kind is only constrained when the recording is filed under a project;
    // an unfiled voice can still be analysed.
    if (kind && projectId) {
      await this.categoryService.assertValid(
        projectId,
        ProjectCategoryKind.ANALYSIS,
        kind,
      );
    }

    this.assertParsableContent(dto.format, content);

    return this.analysisRepo.save(
      this.analysisRepo.create({
        transcription_id: dto.transcription_id,
        project_id: projectId,
        kind,
        title: dto.title.trim(),
        description: dto.description?.trim() || null,
        format: dto.format,
        content,
        source: dto.source?.trim() || null,
        tags: this.normalizeTags(dto.tags),
        pinned: dto.pinned ?? false,
      }),
    );
  }

  async update(
    id: number,
    dto: UpdateAnalysisDto,
  ): Promise<TranscriptAnalysis> {
    const analysis = await this.findById(id);

    if (dto.kind !== undefined) {
      const kind = dto.kind?.trim() || null;
      if (kind && analysis.project_id) {
        await this.categoryService.assertValid(
          analysis.project_id,
          ProjectCategoryKind.ANALYSIS,
          kind,
        );
      }
      analysis.kind = kind;
    }
    if (dto.title !== undefined)
      analysis.title = dto.title.trim() || analysis.title;
    if (dto.description !== undefined) {
      analysis.description = dto.description?.trim() || null;
    }
    if (dto.format !== undefined) analysis.format = dto.format;
    if (dto.content !== undefined) {
      const content = dto.content.trim();
      if (!content) throw new HttpException('متن تحلیل خالی است', 400);
      analysis.content = content;
    }
    if (dto.source !== undefined) analysis.source = dto.source?.trim() || null;
    if (dto.tags !== undefined) analysis.tags = this.normalizeTags(dto.tags);
    if (dto.pinned !== undefined) analysis.pinned = dto.pinned;

    this.assertParsableContent(analysis.format, analysis.content);

    return this.analysisRepo.save(analysis);
  }

  async remove(id: number): Promise<{ success: boolean }> {
    const analysis = await this.findById(id);
    await this.analysisRepo.remove(analysis);
    return { success: true };
  }

  /**
   * Re-file the analyses of a transcription when it moves to another project,
   * so taxonomy usage counts stay honest.
   */
  async syncProject(
    transcriptionId: number,
    projectId: number | null,
  ): Promise<void> {
    await this.analysisRepo.update(
      { transcription_id: transcriptionId },
      {
        project_id: projectId,
      },
    );
  }

  // ---------------------------------------------------------------------------

  /** A document declared as JSON has to actually be JSON. */
  private assertParsableContent(format: AnalysisFormat, content: string): void {
    if (format !== AnalysisFormat.JSON) return;
    try {
      JSON.parse(content);
    } catch {
      throw new HttpException('متن انتخاب‌شده JSON معتبر نیست', 400);
    }
  }

  private normalizeTags(tags?: string[] | null): string[] | null {
    if (!tags?.length) return null;
    const cleaned = [
      ...new Set(tags.map((tag) => String(tag).trim()).filter(Boolean)),
    ];
    return cleaned.length ? cleaned : null;
  }
}
