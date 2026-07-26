import { HttpException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { EvidenceItem, EvidenceTermLink } from './evidence.entity';
import { GlossaryTerm } from '../glossary/glossary.entity';
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
  /** Only evidence linked to this glossary term. */
  termId?: number;
}

@Injectable()
export class EvidenceService {
  constructor(
    @InjectRepository(EvidenceItem)
    private readonly evidenceRepo: Repository<EvidenceItem>,
    @InjectRepository(EvidenceTermLink)
    private readonly linkRepo: Repository<EvidenceTermLink>,
    @InjectRepository(GlossaryTerm)
    private readonly termRepo: Repository<GlossaryTerm>,
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
    if (filter.termId != null) {
      query.andWhere(
        'EXISTS (SELECT 1 FROM evidence_term_links l WHERE l.evidence_id = e.id AND l.term_id = :termId)',
        { termId: filter.termId },
      );
    }
    if (filter.search?.trim()) {
      query.andWhere(
        '(e.quote ILIKE :q OR e.note ILIKE :q OR e.title ILIKE :q OR e.verification ILIKE :q OR e.claim_summary ILIKE :q OR e.follow_up_action ILIKE :q OR CAST(e.tags AS TEXT) ILIKE :q)',
        { q: `%${filter.search.trim()}%` },
      );
    }

    const items = await query.orderBy('e.created_at', 'DESC').getMany();
    return this.withTerms(items);
  }

  async findById(id: number): Promise<EvidenceItem> {
    const item = await this.evidenceRepo.findOne({ where: { id } });
    if (!item) throw new HttpException(NOT_FOUND, 404);
    const [withTerms] = await this.withTerms([item]);
    return withTerms;
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

    const saved = await this.evidenceRepo.save(
      this.evidenceRepo.create({
        project_id: dto.project_id,
        transcription_id: dto.transcription_id ?? null,
        source_title: sourceTitle,
        type: dto.type,
        title: dto.title?.trim() || null,
        quote,
        note: dto.note?.trim() || null,
        tags: this.normalizeTags(dto.tags),
        verification: dto.verification?.trim() || null,
        segment_index: dto.segment_index ?? null,
        end_segment_index: dto.end_segment_index ?? null,
        speaker_label: dto.speaker_label || null,
        start_ms: dto.start_ms ?? null,
        end_ms: dto.end_ms ?? null,
        anchored: dto.anchored ?? true,
        claim_summary: dto.claim_summary?.trim() || null,
        importance: dto.importance ?? null,
        confidence: dto.confidence ?? null,
        sensitivity: dto.sensitivity?.trim() || null,
        requires_validation: dto.requires_validation ?? false,
        validation_methods: this.normalizeTags(dto.validation_methods),
        comparison_potential: dto.comparison_potential?.trim() || null,
        quoted_from_another_person: dto.quoted_from_another_person ?? false,
        referenced_people: this.normalizeTags(dto.referenced_people),
        contains_interviewer_text: dto.contains_interviewer_text ?? false,
        evidence_scope: dto.evidence_scope || null,
        agreement_status: dto.agreement_status || null,
        is_hypothetical_example: dto.is_hypothetical_example ?? false,
        // A follow-up without an action is a reminder to no one, so the flag is
        // only true when there is something concrete to do.
        follow_up_action: dto.follow_up_action?.trim() || null,
        follow_up_required:
          (dto.follow_up_required ?? false) && !!dto.follow_up_action?.trim(),
        origin: dto.origin ?? 'manual',
        ai_meta: dto.ai_meta ?? null,
      }),
    );

    await this.setTermLinks(saved, dto.term_ids);
    return this.findById(saved.id);
  }

  async update(id: number, dto: UpdateEvidenceDto): Promise<EvidenceItem> {
    // The raw row, not `findById`: that one carries a non-column `terms` list.
    const item = await this.evidenceRepo.findOne({ where: { id } });
    if (!item) throw new HttpException(NOT_FOUND, 404);

    if (dto.type !== undefined) {
      await this.categoryService.assertValid(
        item.project_id,
        ProjectCategoryKind.EVIDENCE,
        dto.type,
      );
      item.type = dto.type;
    }
    if (dto.title !== undefined) item.title = dto.title?.trim() || null;
    if (dto.quote !== undefined) item.quote = dto.quote.trim() || item.quote;
    if (dto.note !== undefined) item.note = dto.note?.trim() || null;
    if (dto.tags !== undefined) item.tags = this.normalizeTags(dto.tags);
    if (dto.verification !== undefined) {
      item.verification = dto.verification?.trim() || null;
    }

    // Placing an unanchored item by hand is what clears the flag: a segment
    // given explicitly is a real pointer, so the "بدون ارجاع" badge goes away
    // unless the caller says otherwise.
    if (dto.segment_index !== undefined) {
      item.segment_index = dto.segment_index ?? null;
      if (dto.segment_index != null && dto.anchored === undefined) {
        item.anchored = true;
      }
    }
    if (dto.end_segment_index !== undefined) {
      item.end_segment_index = dto.end_segment_index ?? null;
    }
    if (dto.anchored !== undefined) item.anchored = dto.anchored;

    if (dto.claim_summary !== undefined) {
      item.claim_summary = dto.claim_summary?.trim() || null;
    }
    if (dto.importance !== undefined) item.importance = dto.importance ?? null;
    if (dto.sensitivity !== undefined) {
      item.sensitivity = dto.sensitivity?.trim() || null;
    }
    if (dto.requires_validation !== undefined) {
      item.requires_validation = dto.requires_validation;
    }
    if (dto.validation_methods !== undefined) {
      item.validation_methods = this.normalizeTags(dto.validation_methods);
    }
    if (dto.comparison_potential !== undefined) {
      item.comparison_potential = dto.comparison_potential?.trim() || null;
    }
    if (dto.referenced_people !== undefined) {
      item.referenced_people = this.normalizeTags(dto.referenced_people);
    }
    if (dto.evidence_scope !== undefined) {
      item.evidence_scope = dto.evidence_scope || null;
    }
    if (dto.agreement_status !== undefined) {
      item.agreement_status = dto.agreement_status || null;
    }
    if (dto.is_hypothetical_example !== undefined) {
      item.is_hypothetical_example = dto.is_hypothetical_example;
    }
    if (dto.follow_up_action !== undefined) {
      item.follow_up_action = dto.follow_up_action?.trim() || null;
      item.follow_up_required = !!item.follow_up_action;
    }
    if (dto.follow_up_required !== undefined && !dto.follow_up_required) {
      item.follow_up_required = false;
    }

    await this.evidenceRepo.save(item);
    if (dto.term_ids !== undefined) {
      await this.setTermLinks(item, dto.term_ids, { replace: true });
    }

    return this.findById(id);
  }

  async remove(id: number): Promise<{ success: boolean }> {
    const item = await this.evidenceRepo.findOne({ where: { id } });
    if (!item) throw new HttpException(NOT_FOUND, 404);
    await this.evidenceRepo.remove(item);
    return { success: true };
  }

  // ---------------------------------------------------------------------------
  // Glossary links

  /**
   * Point an evidence item at glossary terms.
   *
   * Terms of a different project are ignored rather than rejected: an extraction
   * run may hand back a term id that has since moved or been deleted, and losing
   * one link is not a reason to lose the whole item.
   */
  private async setTermLinks(
    item: EvidenceItem,
    termIds?: number[],
    options: { replace?: boolean } = {},
  ): Promise<void> {
    if (termIds === undefined) return;

    const wanted = [...new Set(termIds.filter((id) => Number.isInteger(id)))];

    if (options.replace) {
      await this.linkRepo.delete({ evidence_id: item.id });
    }
    if (wanted.length === 0) return;

    const valid = await this.termRepo.find({
      where: { id: In(wanted), project_id: item.project_id },
      select: { id: true },
    });
    if (valid.length === 0) return;

    const existing = options.replace
      ? new Set<number>()
      : new Set(
          (await this.linkRepo.find({ where: { evidence_id: item.id } })).map(
            (link) => link.term_id,
          ),
        );

    const rows = valid
      .filter((term) => !existing.has(term.id))
      .map((term) =>
        this.linkRepo.create({ evidence_id: item.id, term_id: term.id }),
      );

    if (rows.length) await this.linkRepo.save(rows);
  }

  /** Attach the linked terms to each item, for display. */
  private async withTerms(items: EvidenceItem[]): Promise<EvidenceItem[]> {
    if (items.length === 0) return [];

    const links = await this.linkRepo.find({
      where: { evidence_id: In(items.map((item) => item.id)) },
    });
    if (links.length === 0) {
      return items.map((item) => ({ ...item, terms: [] }));
    }

    const terms = await this.termRepo.find({
      where: { id: In([...new Set(links.map((link) => link.term_id))]) },
      select: { id: true, term: true, category: true },
    });
    const termById = new Map(terms.map((term) => [term.id, term]));

    const byEvidence = new Map<number, EvidenceItem['terms']>();
    links.forEach((link) => {
      const term = termById.get(link.term_id);
      if (!term) return;
      const list = byEvidence.get(link.evidence_id) ?? [];
      list.push({ id: term.id, term: term.term, category: term.category });
      byEvidence.set(link.evidence_id, list);
    });

    return items.map((item) => ({
      ...item,
      terms: byEvidence.get(item.id) ?? [],
    }));
  }

  private normalizeTags(tags?: string[] | null): string[] | null {
    if (!tags?.length) return null;
    const cleaned = [
      ...new Set(tags.map((tag) => String(tag).trim()).filter(Boolean)),
    ];
    return cleaned.length ? cleaned : null;
  }
}
