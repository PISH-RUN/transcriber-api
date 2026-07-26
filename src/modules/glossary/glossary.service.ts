import { HttpException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GlossaryMention, GlossaryTerm } from './glossary.entity';
import {
  CreateGlossaryTermDto,
  GlossaryMentionInputDto,
  UpdateGlossaryTermDto,
} from './glossary.dto';
import { ProjectCategoryKind } from '../project/project-category.entity';
import { ProjectCategoryService } from '../project/project-category.service';

const TERM_NOT_FOUND = 'واژه یافت نشد';

export interface ListTermsFilter {
  projectId: number;
  search?: string;
  category?: string;
}

@Injectable()
export class GlossaryService {
  constructor(
    @InjectRepository(GlossaryTerm)
    private readonly termRepo: Repository<GlossaryTerm>,
    @InjectRepository(GlossaryMention)
    private readonly mentionRepo: Repository<GlossaryMention>,
    private readonly categoryService: ProjectCategoryService,
  ) {}

  // ---------------------------------------------------------------------------
  // Terms

  async listTerms(filter: ListTermsFilter): Promise<GlossaryTerm[]> {
    const query = this.termRepo
      .createQueryBuilder('t')
      .where('t.project_id = :projectId', { projectId: filter.projectId });

    if (filter.search?.trim()) {
      query.andWhere(
        '(t.term ILIKE :q OR t.description ILIKE :q OR CAST(t.aliases AS TEXT) ILIKE :q OR CAST(t.tags AS TEXT) ILIKE :q)',
        { q: `%${filter.search.trim()}%` },
      );
    }
    if (filter.category) {
      query.andWhere('t.category = :category', { category: filter.category });
    }

    const terms = await query.orderBy('t.term', 'ASC').getMany();
    return this.withMentionCounts(terms);
  }

  async findTerm(id: number): Promise<GlossaryTerm> {
    const term = await this.termRepo.findOne({ where: { id } });
    if (!term) throw new HttpException(TERM_NOT_FOUND, 404);
    const [withCount] = await this.withMentionCounts([term]);
    return withCount;
  }

  /**
   * Create a term, or reuse the existing one with the same name in the same
   * project. Tagging the same concept twice must never produce a duplicate
   * entry — the second selection becomes another mention (and, when its
   * wording differs, an alias).
   */
  async createTerm(dto: CreateGlossaryTermDto): Promise<GlossaryTerm> {
    const name = dto.term.trim();
    if (!name) throw new HttpException('واژه خالی است', 400);

    // The category must exist in this project's own taxonomy.
    await this.categoryService.assertValid(
      dto.project_id,
      ProjectCategoryKind.GLOSSARY,
      dto.category,
    );

    let term = await this.findByName(dto.project_id, name);

    if (term) {
      term.aliases = this.mergeList(term.aliases, dto.aliases);
      term.tags = this.mergeList(term.tags, dto.tags);
      if (dto.description?.trim() && !term.description) {
        term.description = dto.description.trim();
      }
      term = await this.termRepo.save(term);
    } else {
      term = await this.termRepo.save(
        this.termRepo.create({
          project_id: dto.project_id,
          term: name,
          category: dto.category,
          aliases: this.mergeList(null, dto.aliases),
          tags: this.mergeList(null, dto.tags),
          description: dto.description?.trim() || null,
        }),
      );
    }

    if (dto.mention) {
      await this.addMention(term.id, dto.mention);
    }

    return this.findTerm(term.id);
  }

  async updateTerm(
    id: number,
    dto: UpdateGlossaryTermDto,
  ): Promise<GlossaryTerm> {
    const term = await this.termRepo.findOne({ where: { id } });
    if (!term) throw new HttpException(TERM_NOT_FOUND, 404);

    if (dto.term !== undefined) {
      const name = dto.term.trim();
      const clash = await this.findByName(term.project_id, name);
      if (clash && clash.id !== id) {
        throw new HttpException(
          'واژه‌ای با این نام در این پروژه وجود دارد',
          409,
        );
      }
      term.term = name;
    }
    if (dto.category !== undefined) {
      await this.categoryService.assertValid(
        term.project_id,
        ProjectCategoryKind.GLOSSARY,
        dto.category,
      );
      term.category = dto.category;
    }
    if (dto.aliases !== undefined)
      term.aliases = this.mergeList(null, dto.aliases);
    if (dto.tags !== undefined) term.tags = this.mergeList(null, dto.tags);
    if (dto.description !== undefined) {
      term.description = dto.description?.trim() || null;
    }

    await this.termRepo.save(term);
    return this.findTerm(id);
  }

  async removeTerm(id: number): Promise<{ success: boolean }> {
    const term = await this.termRepo.findOne({ where: { id } });
    if (!term) throw new HttpException(TERM_NOT_FOUND, 404);
    await this.termRepo.remove(term);
    return { success: true };
  }

  // ---------------------------------------------------------------------------
  // Mentions

  async addMention(
    termId: number,
    dto: GlossaryMentionInputDto,
  ): Promise<GlossaryMention> {
    const term = await this.termRepo.findOne({ where: { id: termId } });
    if (!term) throw new HttpException(TERM_NOT_FOUND, 404);

    // A selected form that differs from the canonical spelling is worth
    // remembering, so highlighting can find it next time.
    const surface = dto.surface?.trim();
    if (surface && surface !== term.term) {
      term.aliases = this.mergeList(term.aliases, [surface]);
      await this.termRepo.save(term);
    }

    return this.mentionRepo.save(
      this.mentionRepo.create({
        term_id: termId,
        transcription_id: dto.transcription_id,
        segment_index: dto.segment_index ?? null,
        start_offset: dto.start_offset ?? null,
        end_offset: dto.end_offset ?? null,
        surface: surface || null,
        context: dto.context?.trim() || null,
        speaker_label: dto.speaker_label || null,
        start_ms: dto.start_ms ?? null,
      }),
    );
  }

  /** Mentions of one term, newest first, across every recording. */
  listTermMentions(termId: number): Promise<GlossaryMention[]> {
    return this.mentionRepo.find({
      where: { term_id: termId },
      order: { created_at: 'DESC' },
    });
  }

  /**
   * Every mention inside one transcript, each carrying its term. Used by the
   * review page to mark up the text.
   */
  listTranscriptionMentions(
    transcriptionId: number,
  ): Promise<GlossaryMention[]> {
    return this.mentionRepo
      .createQueryBuilder('m')
      .leftJoinAndSelect('m.term', 'term')
      .where('m.transcription_id = :transcriptionId', { transcriptionId })
      .orderBy('m.segment_index', 'ASC')
      .addOrderBy('m.start_offset', 'ASC')
      .getMany();
  }

  async removeMention(id: number): Promise<{ success: boolean }> {
    const mention = await this.mentionRepo.findOne({ where: { id } });
    if (!mention) throw new HttpException('ارجاع یافت نشد', 404);
    await this.mentionRepo.remove(mention);
    return { success: true };
  }

  // ---------------------------------------------------------------------------
  // Helpers

  private async withMentionCounts(
    terms: GlossaryTerm[],
  ): Promise<GlossaryTerm[]> {
    if (terms.length === 0) return [];

    const rows: Array<{ term_id: number; count: string }> =
      await this.mentionRepo
        .createQueryBuilder('m')
        .select('m.term_id', 'term_id')
        .addSelect('COUNT(*)', 'count')
        .where('m.term_id IN (:...ids)', { ids: terms.map((t) => t.id) })
        .groupBy('m.term_id')
        .getRawMany();

    const counts = new Map(
      rows.map((row) => [Number(row.term_id), Number(row.count)]),
    );

    return terms.map((term) => ({
      ...term,
      mention_count: counts.get(term.id) ?? 0,
    }));
  }

  private findByName(
    projectId: number,
    name: string,
  ): Promise<GlossaryTerm | null> {
    return this.termRepo
      .createQueryBuilder('t')
      .where('t.project_id = :projectId', { projectId })
      .andWhere('LOWER(TRIM(t.term)) = LOWER(:name)', { name: name.trim() })
      .getOne();
  }

  /** Union of two string lists, trimmed and de-duplicated; empty -> null. */
  private mergeList(
    current?: string[] | null,
    incoming?: string[] | null,
  ): string[] | null {
    const merged = [
      ...new Set(
        [...(current ?? []), ...(incoming ?? [])]
          .map((value) => String(value).trim())
          .filter(Boolean),
      ),
    ];
    return merged.length ? merged : null;
  }
}
