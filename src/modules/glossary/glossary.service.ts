import { HttpException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GlossaryMention, GlossaryTerm } from './glossary.entity';
import {
  CreateGlossaryTermDto,
  GlossaryMentionInputDto,
  UpdateGlossaryTermDto,
} from './glossary.dto';
import { EvidenceTermLink } from '../evidence/evidence.entity';
import { ProjectCategoryKind } from '../project/project-category.entity';
import { ProjectCategoryService } from '../project/project-category.service';

const TERM_NOT_FOUND = 'واژه یافت نشد';

export interface ListTermsFilter {
  projectId: number;
  search?: string;
  category?: string;
}

/** What a merge actually did, so the UI can report it instead of guessing. */
export interface MergeTermsResult {
  term: GlossaryTerm;
  /** Name of the entry that no longer exists. */
  merged_term: string;
  mentions_moved: number;
  /** Mentions discarded because the survivor already covered that line. */
  mentions_dropped: number;
  evidence_links_moved: number;
  aliases_added: number;
}

/** What detaching a wording did. */
export interface DetachAliasResult {
  term: GlossaryTerm;
  detached_form: string;
  mode: 'remove' | 'promote';
  mentions_moved: number;
  mentions_removed: number;
  /** The new entry, when the wording was promoted rather than dropped. */
  created_term: GlossaryTerm | null;
}

/** Case-insensitive, whitespace-insensitive identity of a wording. */
function normalizeName(value: string): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

/** One mention per transcript line — the identity a merge must not duplicate. */
function mentionKey(mention: {
  transcription_id: number;
  segment_index?: number | null;
}): string {
  return `${mention.transcription_id}:${mention.segment_index ?? 'null'}`;
}

@Injectable()
export class GlossaryService {
  private readonly logger = new Logger(GlossaryService.name);

  constructor(
    @InjectRepository(GlossaryTerm)
    private readonly termRepo: Repository<GlossaryTerm>,
    @InjectRepository(GlossaryMention)
    private readonly mentionRepo: Repository<GlossaryMention>,
    @InjectRepository(EvidenceTermLink)
    private readonly evidenceLinkRepo: Repository<EvidenceTermLink>,
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
        '(t.term ILIKE :q OR t.description ILIKE :q OR t.status ILIKE :q OR CAST(t.aliases AS TEXT) ILIKE :q OR CAST(t.tags AS TEXT) ILIKE :q)',
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
      // A status already set by hand outranks whatever a bulk import carries.
      if (dto.status?.trim() && !term.status) {
        term.status = dto.status.trim();
      }
      // Merging into an existing entry keeps the higher importance: the term
      // has now been seen in one more place, which never makes it less central.
      if (dto.importance != null) {
        term.importance = Math.max(term.importance ?? 0, dto.importance);
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
          status: dto.status?.trim() || null,
          origin: dto.origin ?? 'manual',
          importance: dto.importance ?? null,
          confidence: dto.confidence ?? null,
          needs_review: dto.needs_review ?? false,
          review_note: dto.review_note?.trim() || null,
          ai_meta: dto.ai_meta ?? null,
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
    if (dto.status !== undefined) {
      term.status = dto.status?.trim() || null;
    }
    if (dto.importance !== undefined) term.importance = dto.importance ?? null;
    if (dto.needs_review !== undefined) term.needs_review = dto.needs_review;
    if (dto.review_note !== undefined) {
      term.review_note = dto.review_note?.trim() || null;
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

  /**
   * Record more wordings of a term that is already in the glossary.
   *
   * The case this exists for: the same person is called "علی" in one recording,
   * "علی آقا" in the next and "علی اسماعیلی" in a third. Those are one entry with
   * three surface forms, not three entries — and because the scan matches on
   * `term` plus every alias, adding the form here is what makes the older
   * recordings light up too.
   *
   * Everything else on the payload is merged the way `createTerm` merges into an
   * existing entry: fill the empty fields, keep the higher importance, never
   * overwrite what a human already wrote.
   */
  async attachAliases(
    targetId: number,
    input: {
      aliases: string[];
      tags?: string[] | null;
      description?: string | null;
      status?: string | null;
      importance?: number | null;
      ai_meta?: Record<string, unknown> | null;
    },
  ): Promise<GlossaryTerm> {
    const term = await this.termRepo.findOne({ where: { id: targetId } });
    if (!term) throw new HttpException(TERM_NOT_FOUND, 404);

    // The canonical spelling is not one of its own alternatives.
    const canonical = normalizeName(term.term);
    const incoming = (input.aliases ?? []).filter(
      (alias) => normalizeName(alias) !== canonical,
    );

    term.aliases = this.mergeList(term.aliases, incoming);
    term.tags = this.mergeList(term.tags, input.tags);

    if (input.description?.trim() && !term.description) {
      term.description = input.description.trim();
    }
    if (input.status?.trim() && !term.status) {
      term.status = input.status.trim();
    }
    if (input.importance != null) {
      term.importance = Math.max(term.importance ?? 0, input.importance);
    }
    if (input.ai_meta) {
      term.ai_meta = { ...(term.ai_meta ?? {}), ...input.ai_meta };
    }

    await this.termRepo.save(term);
    return this.findTerm(targetId);
  }

  /**
   * Take one wording back off a term.
   *
   * The undo for the two ways wordings get joined (the wizard's "same entry,
   * different spelling" and a merge), plus the honest answer to a wrong alias:
   * an alias is not cosmetic, it is what the scan and the highlighter match on,
   * so a wrong one keeps producing wrong references until it is removed.
   *
   * `mode: 'promote'` is for the case where the wording was not wrong, just not
   * the same thing: it becomes an entry of its own and takes its references with
   * it. `mode: 'remove'` simply drops it, along with the references that only
   * exist because of it.
   */
  async detachAlias(
    termId: number,
    input: { form: string; mode?: 'remove' | 'promote'; category?: string },
  ): Promise<DetachAliasResult> {
    const term = await this.termRepo.findOne({ where: { id: termId } });
    if (!term) throw new HttpException(TERM_NOT_FOUND, 404);

    const form = String(input.form ?? '').trim();
    const canonical = normalizeName(form);
    if (!canonical) throw new HttpException('شکل واژه خالی است', 400);

    if (canonical === normalizeName(term.term)) {
      throw new HttpException(
        'این شکل رسمی خودِ واژه است و جدا نمی‌شود؛ برای تغییرش واژه را ویرایش کنید',
        400,
      );
    }

    const remaining = (term.aliases ?? []).filter(
      (alias) => normalizeName(alias) !== canonical,
    );
    if (remaining.length === (term.aliases?.length ?? 0)) {
      throw new HttpException('این شکل در فهرست شکل‌های این واژه نیست', 404);
    }

    // References that exist only because of this wording. Matched on the stored
    // `surface`, which is what was actually found in the text — comparing
    // against the term instead would take down the correct references too.
    const mentions = (
      await this.mentionRepo.find({ where: { term_id: termId } })
    ).filter((mention) => normalizeName(mention.surface ?? '') === canonical);

    let promoted: GlossaryTerm | null = null;

    if (input.mode === 'promote') {
      const category = input.category?.trim() || term.category;
      await this.categoryService.assertValid(
        term.project_id,
        ProjectCategoryKind.GLOSSARY,
        category,
      );

      const clash = await this.findByName(term.project_id, form);
      if (clash) {
        throw new HttpException(
          `واژه‌ای با نام «${form}» از قبل در این پروژه هست`,
          409,
        );
      }

      promoted = await this.termRepo.save(
        this.termRepo.create({
          project_id: term.project_id,
          term: form,
          category,
          origin: term.origin,
          ai_meta: { detached_from: { id: term.id, term: term.term } },
        }),
      );

      // The references move with it: they were real occurrences of this wording,
      // only filed under the wrong entry.
      mentions.forEach((mention) => {
        mention.term_id = promoted!.id;
      });
      if (mentions.length > 0) {
        await this.mentionRepo.save(mentions, { chunk: 200 });
      }
    } else if (mentions.length > 0) {
      await this.mentionRepo.remove(mentions, { chunk: 200 });
    }

    term.aliases = remaining.length ? remaining : null;
    await this.termRepo.save(term);

    this.logger.log(
      `[Glossary] Detached "${form}" from term ${termId} (${input.mode ?? 'remove'}): ` +
        `${mentions.length} mention(s) ${input.mode === 'promote' ? 'moved' : 'removed'}`,
    );

    return {
      term: await this.findTerm(termId),
      detached_form: form,
      mode: input.mode === 'promote' ? 'promote' : 'remove',
      mentions_moved: input.mode === 'promote' ? mentions.length : 0,
      mentions_removed: input.mode === 'promote' ? 0 : mentions.length,
      created_term: promoted ? await this.findTerm(promoted.id) : null,
    };
  }

  /**
   * Fold one term into another and delete it.
   *
   * Needed because the split usually only becomes visible later: "علی" and "علی
   * اسماعیلی" are entered from different recordings, weeks apart, and nobody
   * notices they are one person until both have mentions and evidence hanging
   * off them. Deleting one of them would throw that history away, so the two
   * histories are joined instead.
   *
   * The loser's name and alternatives become alternatives of the survivor, which
   * is what keeps highlighting and the scan working on the old wordings.
   */
  async mergeTerms(
    sourceId: number,
    targetId: number,
  ): Promise<MergeTermsResult> {
    if (sourceId === targetId) {
      throw new HttpException('نمی‌توان یک واژه را با خودش ادغام کرد', 400);
    }

    const source = await this.termRepo.findOne({ where: { id: sourceId } });
    if (!source) throw new HttpException(TERM_NOT_FOUND, 404);
    const target = await this.termRepo.findOne({ where: { id: targetId } });
    if (!target) throw new HttpException(TERM_NOT_FOUND, 404);

    // Nothing in the schema stops a cross-project merge, and it would quietly
    // move one project's references into another's dictionary.
    if (source.project_id !== target.project_id) {
      throw new HttpException(
        'دو واژه از یک پروژه نیستند و ادغام‌شان ممکن نیست',
        400,
      );
    }

    // --- mentions: keep one per (transcript, line) ---------------------------
    // `glossary_mentions` has no unique index on that pair — the one-per-line
    // rule lives in the scan's code — so a blind repoint would leave the merged
    // term with the same line listed twice.
    const targetKeys = new Set(
      (
        await this.mentionRepo.find({
          where: { term_id: targetId },
          select: { transcription_id: true, segment_index: true },
        })
      ).map((mention) => mentionKey(mention)),
    );

    const sourceMentions = await this.mentionRepo.find({
      where: { term_id: sourceId },
    });

    const moving: GlossaryMention[] = [];
    const dropping: GlossaryMention[] = [];
    sourceMentions.forEach((mention) => {
      const key = mentionKey(mention);
      if (targetKeys.has(key)) {
        dropping.push(mention);
      } else {
        targetKeys.add(key);
        mention.term_id = targetId;
        moving.push(mention);
      }
    });

    if (moving.length > 0) {
      await this.mentionRepo.save(moving, { chunk: 200 });
    }
    if (dropping.length > 0) {
      await this.mentionRepo.remove(dropping, { chunk: 200 });
    }

    // --- evidence links: unique per (evidence, term) -------------------------
    const evidenceMoved = await this.moveEvidenceLinks(sourceId, targetId);

    // --- the entry itself ---------------------------------------------------
    const before = target.aliases?.length ?? 0;
    const merged = await this.attachAliases(targetId, {
      aliases: [source.term, ...(source.aliases ?? [])],
      tags: source.tags,
      description: source.description,
      status: source.status,
      importance: source.importance,
      ai_meta: source.ai_meta
        ? { merged_from: { id: source.id, term: source.term } }
        : null,
    });

    await this.termRepo.remove(source);

    this.logger.log(
      `[Glossary] Merged term ${sourceId} ("${source.term}") into ${targetId} ("${target.term}"): ` +
        `${moving.length} mention(s) moved, ${dropping.length} duplicate(s) dropped, ` +
        `${evidenceMoved} evidence link(s) moved`,
    );

    return {
      term: merged,
      merged_term: source.term,
      mentions_moved: moving.length,
      mentions_dropped: dropping.length,
      evidence_links_moved: evidenceMoved,
      aliases_added: (merged.aliases?.length ?? 0) - before,
    };
  }

  /**
   * Repoint the loser's evidence links, dropping the ones the survivor already
   * has (`uq_evidence_term` would reject them).
   */
  private async moveEvidenceLinks(
    sourceId: number,
    targetId: number,
  ): Promise<number> {
    const links = await this.evidenceLinkRepo.find({
      where: [{ term_id: sourceId }, { term_id: targetId }],
    });

    const targetEvidence = new Set(
      links
        .filter((link) => link.term_id === targetId)
        .map((link) => link.evidence_id),
    );

    const moving: EvidenceTermLink[] = [];
    const dropping: EvidenceTermLink[] = [];
    links
      .filter((link) => link.term_id === sourceId)
      .forEach((link) => {
        if (targetEvidence.has(link.evidence_id)) {
          dropping.push(link);
        } else {
          targetEvidence.add(link.evidence_id);
          link.term_id = targetId;
          moving.push(link);
        }
      });

    if (moving.length > 0) await this.evidenceLinkRepo.save(moving);
    if (dropping.length > 0) await this.evidenceLinkRepo.remove(dropping);

    return moving.length;
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

  /**
   * Existing term with this name in this project, if any. Public so bulk import
   * can tell "will create" from "will merge" before writing anything.
   */
  findByNameInProject(
    projectId: number,
    name: string,
  ): Promise<GlossaryTerm | null> {
    return this.findByName(projectId, name);
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
