import { HttpException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EvidenceItem } from './evidence.entity';
import { CreateEvidenceDto, UpdateEvidenceDto } from './evidence.dto';
import { Transcription } from '../transcription/transcription.entity';
import { ProjectCategoryKind } from '../project/project-category.entity';
import { ProjectCategoryService } from '../project/project-category.service';

const NOT_FOUND = 'شواهد یافت نشد';

export interface ListEvidenceFilter {
  projectId?: number;
  transcriptionId?: number;
  types?: string[];
  search?: string;
}

@Injectable()
export class EvidenceService {
  constructor(
    @InjectRepository(EvidenceItem)
    private readonly evidenceRepo: Repository<EvidenceItem>,
    @InjectRepository(Transcription)
    private readonly transcriptionRepo: Repository<Transcription>,
    private readonly categoryService: ProjectCategoryService,
  ) {}

  async list(filter: ListEvidenceFilter): Promise<EvidenceItem[]> {
    const query = this.evidenceRepo.createQueryBuilder('e');

    if (filter.projectId != null) {
      query.andWhere('e.project_id = :projectId', {
        projectId: filter.projectId,
      });
    }
    if (filter.transcriptionId != null) {
      query.andWhere('e.transcription_id = :transcriptionId', {
        transcriptionId: filter.transcriptionId,
      });
    }
    if (filter.types?.length) {
      query.andWhere('e.type IN (:...types)', { types: filter.types });
    }
    if (filter.search?.trim()) {
      query.andWhere(
        '(e.quote ILIKE :q OR e.note ILIKE :q OR CAST(e.tags AS TEXT) ILIKE :q)',
        { q: `%${filter.search.trim()}%` },
      );
    }

    return query.orderBy('e.created_at', 'DESC').getMany();
  }

  async findById(id: number): Promise<EvidenceItem> {
    const item = await this.evidenceRepo.findOne({ where: { id } });
    if (!item) throw new HttpException(NOT_FOUND, 404);
    return item;
  }

  async create(dto: CreateEvidenceDto): Promise<EvidenceItem> {
    const quote = dto.quote.trim();
    if (!quote) throw new HttpException('متن شواهد خالی است', 400);

    // The type must exist in this project's own taxonomy.
    await this.categoryService.assertValid(
      dto.project_id,
      ProjectCategoryKind.EVIDENCE,
      dto.type,
    );

    // Snapshot the source title: the basket has to stay readable if the
    // recording is deleted later.
    let sourceTitle: string | null = null;
    if (dto.transcription_id != null) {
      const source = await this.transcriptionRepo
        .createQueryBuilder('t')
        .select(['t.id', 't.title'])
        .where('t.id = :id', { id: dto.transcription_id })
        .getOne();
      if (!source) throw new HttpException('رونویسی یافت نشد', 404);
      sourceTitle = source.title;
    }

    return this.evidenceRepo.save(
      this.evidenceRepo.create({
        project_id: dto.project_id,
        transcription_id: dto.transcription_id ?? null,
        source_title: sourceTitle,
        type: dto.type,
        quote,
        note: dto.note?.trim() || null,
        tags: this.normalizeTags(dto.tags),
        segment_index: dto.segment_index ?? null,
        speaker_label: dto.speaker_label || null,
        start_ms: dto.start_ms ?? null,
      }),
    );
  }

  async update(id: number, dto: UpdateEvidenceDto): Promise<EvidenceItem> {
    const item = await this.findById(id);

    if (dto.type !== undefined) {
      await this.categoryService.assertValid(
        item.project_id,
        ProjectCategoryKind.EVIDENCE,
        dto.type,
      );
      item.type = dto.type;
    }
    if (dto.quote !== undefined) item.quote = dto.quote.trim() || item.quote;
    if (dto.note !== undefined) item.note = dto.note?.trim() || null;
    if (dto.tags !== undefined) item.tags = this.normalizeTags(dto.tags);

    return this.evidenceRepo.save(item);
  }

  async remove(id: number): Promise<{ success: boolean }> {
    const item = await this.findById(id);
    await this.evidenceRepo.remove(item);
    return { success: true };
  }

  private normalizeTags(tags?: string[] | null): string[] | null {
    if (!tags?.length) return null;
    const cleaned = [
      ...new Set(tags.map((tag) => String(tag).trim()).filter(Boolean)),
    ];
    return cleaned.length ? cleaned : null;
  }
}
