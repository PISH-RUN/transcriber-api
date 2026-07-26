import { HttpException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AiCandidateRejection,
  AiExtractionRun,
  ExtractionKind,
  ExtractionStatus,
} from './ai-extraction.entity';
import { ApplyExtractionDto, StartExtractionDto } from './ai-extraction.dto';
import { GlossaryExtractionService } from './glossary-extraction.service';
import { EvidenceExtractionService } from './evidence-extraction.service';
import {
  StoredCandidate,
  errorMessage,
  fingerprintOf,
} from './extraction-common';
import { Transcription } from '../transcription/transcription.entity';
import { GlossaryService } from '../glossary/glossary.service';
import { GlossaryScanService } from '../glossary/glossary-scan.service';
import { EvidenceService } from '../evidence/evidence.service';
import { ProjectCategoryKind } from '../project/project-category.entity';
import { ProjectCategoryService } from '../project/project-category.service';
import { PersonService } from '../person/person.service';
import { GlossaryTerm } from '../glossary/glossary.entity';
import { EvidenceItem } from '../evidence/evidence.entity';
import { Project } from '../project/project.entity';

/** Rejections fed back to the model. Beyond this the prompt bloats for nothing. */
const MAX_REJECTIONS_SENT = 120;

/** Evidence quotes are long; a rejection only needs enough to be recognised. */
const REJECTION_LABEL_LIMIT = 400;

export interface ApplyResult {
  accepted: number;
  rejected: number;
  /** Glossary runs: mentions recorded for the newly accepted terms. */
  mentions_created?: number;
  /** Ids of what was created, so the UI can jump straight to it. */
  created_ids: number[];
  problems: Array<{ candidate_id: number; reason: string }>;
}

/**
 * Runs the two AI extraction passes and turns their proposals into real
 * glossary and evidence records once a human has approved them.
 *
 * Nothing the model returns is written on its own. A run is a proposal list the
 * reviewer triages; approval is a separate, explicit call. That separation is the
 * whole design: the model is trusted to notice what matters and never trusted to
 * decide what the project knows.
 */
@Injectable()
export class AiExtractionService {
  private readonly logger = new Logger(AiExtractionService.name);

  constructor(
    @InjectRepository(AiExtractionRun)
    private readonly runRepo: Repository<AiExtractionRun>,
    @InjectRepository(AiCandidateRejection)
    private readonly rejectionRepo: Repository<AiCandidateRejection>,
    @InjectRepository(Transcription)
    private readonly transcriptionRepo: Repository<Transcription>,
    @InjectRepository(GlossaryTerm)
    private readonly termRepo: Repository<GlossaryTerm>,
    @InjectRepository(EvidenceItem)
    private readonly evidenceRepo: Repository<EvidenceItem>,
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    private readonly glossaryExtraction: GlossaryExtractionService,
    private readonly evidenceExtraction: EvidenceExtractionService,
    private readonly glossaryService: GlossaryService,
    private readonly glossaryScan: GlossaryScanService,
    private readonly evidenceService: EvidenceService,
    private readonly categoryService: ProjectCategoryService,
    private readonly personService: PersonService,
  ) {}

  // ---------------------------------------------------------------------------
  // Starting a run

  /**
   * Begin an extraction and return the run row immediately.
   *
   * A two-hour interview takes minutes, so the HTTP request cannot wait for it.
   * The frontend follows `status` on the run, exactly as it already does for the
   * AI proof-reading pass.
   */
  async start(
    kind: ExtractionKind,
    dto: StartExtractionDto,
  ): Promise<AiExtractionRun> {
    if (!this.glossaryExtraction.isConfigured()) {
      throw new HttpException(
        'کلید سرویس هوش مصنوعی تنظیم نشده است (OPENROUTER_API_KEY یا GEMINI_API_KEY)',
        503,
      );
    }

    const transcription = await this.transcriptionRepo.findOne({
      where: { id: dto.transcription_id },
    });
    if (!transcription) throw new HttpException('رونویسی یافت نشد', 404);
    if (!transcription.project_id) {
      throw new HttpException(
        'این رونویسی پروژه ندارد؛ دیکشنری و سبد شواهد در سطح پروژه نگه داشته می‌شوند',
        400,
      );
    }
    if (!transcription.segments?.length) {
      throw new HttpException('متن رونویسی آماده نیست', 400);
    }

    // Marking the interviewers is part of setting up the run, so accept it here
    // instead of forcing a separate PATCH before every extraction.
    if (dto.interviewer_speaker_ids !== undefined) {
      const ids = [
        ...new Set(
          dto.interviewer_speaker_ids
            .map((v) => String(v).trim())
            .filter(Boolean),
        ),
      ];
      transcription.interviewer_speaker_ids = ids.length ? ids : null;
      await this.transcriptionRepo.update(transcription.id, {
        interviewer_speaker_ids: transcription.interviewer_speaker_ids,
      });
    }

    // A second click while the first call is in flight would double the cost and
    // produce two competing candidate lists.
    const running = await this.runRepo.findOne({
      where: {
        transcription_id: transcription.id,
        kind,
        status: ExtractionStatus.PROCESSING,
      },
      order: { id: 'DESC' },
    });
    if (running) return this.strip(running);

    const run = await this.runRepo.save(
      this.runRepo.create({
        transcription_id: transcription.id,
        project_id: transcription.project_id,
        kind,
        status: ExtractionStatus.PROCESSING,
        message: 'در حال تحلیل متن با هوش مصنوعی...',
      }),
    );

    this.execute(run.id, kind, transcription).catch((error: unknown) => {
      this.logger.error(
        `[Extraction] Run ${run.id} (${kind}) crashed: ${errorMessage(error)}`,
      );
    });

    return this.strip(run);
  }

  private async execute(
    runId: number,
    kind: ExtractionKind,
    transcription: Transcription,
  ): Promise<void> {
    const startedAt = Date.now();
    const projectId = transcription.project_id!;

    try {
      // The project's own description is the only project-level context we have,
      // and the prompts use it purely to judge relevance.
      const project = await this.projectRepo.findOne({
        where: { id: projectId },
      });
      const projectContext = project?.description ?? null;

      const rejectedLabels = await this.loadRejections(projectId, kind);
      const speakerNames = await this.resolveSpeakerNames(transcription);

      if (kind === ExtractionKind.GLOSSARY) {
        const [categories, existingTerms] = await Promise.all([
          this.categoryService.list(projectId, ProjectCategoryKind.GLOSSARY),
          this.termRepo.find({ where: { project_id: projectId } }),
        ]);

        const output = await this.glossaryExtraction.extract({
          segments: transcription.segments!,
          categories,
          existingTerms,
          projectContext,
          interviewerSpeakerIds: transcription.interviewer_speaker_ids,
          speakerNames,
          rejectedLabels,
        });

        await this.runRepo.update(runId, {
          status: ExtractionStatus.DONE,
          message: output.candidates.length
            ? `${output.candidates.length} واژه پیشنهاد شد`
            : 'واژه تازه‌ای پیدا نشد',
          model: output.model,
          // The column is deliberately schema-free (a prompt change must not
          // need a migration) and TypeORM's deep-partial typing cannot express
          // "any JSON", so the cast is the honest way to say it.
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          candidates: output.candidates as any,
          warnings: output.warnings,
          prompt_chars: output.promptChars,
          response_chars: output.responseChars,
          duration_ms: Date.now() - startedAt,
        });
      } else {
        const [types, glossary, existingEvidence] = await Promise.all([
          this.categoryService.list(projectId, ProjectCategoryKind.EVIDENCE),
          this.termRepo.find({ where: { project_id: projectId } }),
          this.evidenceRepo.find({ where: { project_id: projectId } }),
        ]);

        const output = await this.evidenceExtraction.extract({
          segments: transcription.segments!,
          types,
          glossary,
          existingEvidence,
          projectContext,
          interviewerSpeakerIds: transcription.interviewer_speaker_ids,
          speakerNames,
          rejectedLabels,
        });

        const anchored = output.candidates.filter(
          (item) => item.anchored,
        ).length;
        await this.runRepo.update(runId, {
          status: ExtractionStatus.DONE,
          message: output.candidates.length
            ? `${output.candidates.length} شاهد پیشنهاد شد (${anchored} با ارجاع در متن)`
            : 'شاهد تازه‌ای پیدا نشد',
          model: output.model,
          // Schema-free jsonb; see the glossary branch above.
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          candidates: output.candidates as any,
          warnings: output.warnings,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          coverage: (output.coverage ?? null) as any,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          source_characterization: (output.sourceCharacterization ??
            null) as any,
          prompt_chars: output.promptChars,
          response_chars: output.responseChars,
          duration_ms: Date.now() - startedAt,
        });
      }

      this.logger.log(
        `[Extraction] Run ${runId} (${kind}) done in ${Math.round(
          (Date.now() - startedAt) / 1000,
        )}s`,
      );
    } catch (error: unknown) {
      const reason = errorMessage(error);
      await this.runRepo.update(runId, {
        status: ExtractionStatus.FAILED,
        message: `خطا در استخراج: ${reason}`.slice(0, 500),
        duration_ms: Date.now() - startedAt,
      });
      this.logger.error(`[Extraction] Run ${runId} failed: ${reason}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Reading runs

  async findRun(id: number): Promise<AiExtractionRun> {
    const run = await this.runRepo.findOne({ where: { id } });
    if (!run) throw new HttpException('اجرای استخراج یافت نشد', 404);
    return run;
  }

  /**
   * Runs for one transcript, newest first, without their candidate lists — the
   * list is for picking a run, and the candidates are the heavy part.
   */
  async listRuns(
    transcriptionId: number,
    kind?: ExtractionKind,
  ): Promise<AiExtractionRun[]> {
    const runs = await this.runRepo.find({
      where: {
        transcription_id: transcriptionId,
        ...(kind ? { kind } : {}),
      },
      order: { created_at: 'DESC' },
      take: 20,
    });
    return runs.map((run) => this.strip(run));
  }

  /** The run the wizard should open: the newest one that is still actionable. */
  async latestRun(
    transcriptionId: number,
    kind: ExtractionKind,
  ): Promise<AiExtractionRun | null> {
    return this.runRepo.findOne({
      where: { transcription_id: transcriptionId, kind },
      order: { created_at: 'DESC' },
    });
  }

  // ---------------------------------------------------------------------------
  // Applying decisions

  /**
   * Write the accepted candidates into the project and remember the rejected
   * ones.
   *
   * Partial failures do not abort the batch: one candidate with a bad category
   * must not cost the reviewer the other twenty decisions they just made.
   */
  async apply(runId: number, dto: ApplyExtractionDto): Promise<ApplyResult> {
    const run = await this.findRun(runId);
    if (run.status !== ExtractionStatus.DONE) {
      throw new HttpException('این اجرا هنوز نتیجه‌ای ندارد', 400);
    }

    // The one place the schema-free jsonb column becomes typed data; everything
    // downstream is checked.
    const candidates = (run.candidates ?? []) as unknown as StoredCandidate[];
    const byId = new Map(
      candidates.map((candidate) => [
        Number(candidate.candidate_id),
        candidate,
      ]),
    );

    const result: ApplyResult = {
      accepted: 0,
      rejected: 0,
      created_ids: [],
      problems: [],
    };
    const acceptedTermIds: number[] = [];

    for (const decision of dto.decisions) {
      const candidate = byId.get(decision.candidate_id);
      if (!candidate) {
        result.problems.push({
          candidate_id: decision.candidate_id,
          reason: 'این کاندید در این اجرا نیست',
        });
        continue;
      }
      // Re-applying a run must not create the same record twice.
      if (candidate.decision && candidate.decision !== 'pending') continue;

      const merged = this.applyEdits(run.kind, candidate, decision.edits);

      if (decision.decision === 'rejected') {
        await this.rememberRejection(run, merged);
        candidate.decision = 'rejected';
        result.rejected += 1;
        continue;
      }

      try {
        const id =
          run.kind === ExtractionKind.GLOSSARY
            ? await this.createTerm(run, merged)
            : await this.createEvidence(run, merged);

        candidate.decision = 'accepted';
        candidate.created_id = id;
        result.accepted += 1;
        result.created_ids.push(id);
        if (run.kind === ExtractionKind.GLOSSARY) acceptedTermIds.push(id);
      } catch (error: unknown) {
        result.problems.push({
          candidate_id: decision.candidate_id,
          reason: errorMessage(error),
        });
      }
    }

    // A term the model found gets at most three example mentions. The scan finds
    // every line it occurs in, which is what the panel is actually for.
    if (acceptedTermIds.length > 0) {
      try {
        const scan = await this.glossaryScan.scan({
          projectId: run.project_id,
          transcriptionId: run.transcription_id,
          termIds: acceptedTermIds,
        });
        result.mentions_created = scan.mentions_created;
      } catch (error: unknown) {
        this.logger.warn(
          `[Extraction] Post-apply scan for run ${runId} failed: ${errorMessage(error)}`,
        );
      }
    }

    await this.runRepo.update(runId, {
      candidates: candidates as unknown as Array<Record<string, any>>,
      accepted_count: candidates.filter((c) => c.decision === 'accepted')
        .length,
      rejected_count: candidates.filter((c) => c.decision === 'rejected')
        .length,
      applied_at: new Date(),
    });

    this.logger.log(
      `[Extraction] Run ${runId} applied: ${result.accepted} accepted, ${result.rejected} rejected`,
    );

    return result;
  }

  // ---------------------------------------------------------------------------
  // Helpers

  /**
   * Overlay the reviewer's edits on a candidate, accepting only fields that
   * belong to its kind. A whitelist rather than a spread: `edits` arrives from
   * the browser, and a blind merge would let it rewrite `decision`, `problems`
   * or the anchoring we computed.
   */
  private applyEdits(
    kind: ExtractionKind,
    candidate: StoredCandidate,
    edits?: Record<string, unknown>,
  ): StoredCandidate {
    const allowed =
      kind === ExtractionKind.GLOSSARY
        ? [
            'term',
            'category',
            'definition',
            'aliases',
            'tags',
            'status',
            'importance',
            'review_note',
          ]
        : [
            'title',
            'type',
            'quote',
            'note',
            'claim_summary',
            'tags',
            'term_ids',
            'verification',
            'importance',
            'sensitivity',
            'segment_index',
            'end_segment_index',
            'requires_validation',
            'comparison_potential',
            'evidence_scope',
            'agreement_status',
            'is_hypothetical_example',
            'follow_up_required',
            'follow_up_action',
          ];

    const merged: Record<string, unknown> = { ...candidate };
    if (edits) {
      allowed.forEach((key) => {
        if (edits[key] !== undefined) merged[key] = edits[key];
      });
    }
    return merged as unknown as StoredCandidate;
  }

  private async createTerm(
    run: AiExtractionRun,
    candidate: StoredCandidate,
  ): Promise<number> {
    const term = await this.glossaryService.createTerm({
      project_id: run.project_id,
      term: String(candidate.term ?? '').trim(),
      category: String(candidate.category ?? '').trim(),
      aliases: Array.isArray(candidate.aliases) ? candidate.aliases : undefined,
      tags: Array.isArray(candidate.tags) ? candidate.tags : undefined,
      description: candidate.definition || undefined,
      status: candidate.status || undefined,
      origin: 'ai',
      importance: candidate.importance ?? undefined,
      confidence: candidate.confidence ?? undefined,
      needs_review: candidate.needs_review === true,
      review_note: candidate.review_note || undefined,
      ai_meta: this.termMeta(run, candidate),
    });
    return term.id;
  }

  private async createEvidence(
    run: AiExtractionRun,
    candidate: StoredCandidate,
  ): Promise<number> {
    const type = String(candidate.type ?? '').trim();
    if (!type) {
      throw new Error('نوع شاهد انتخاب نشده است');
    }

    const item = await this.evidenceService.create({
      project_id: run.project_id,
      transcription_id: run.transcription_id,
      type,
      title: candidate.title || undefined,
      quote: String(candidate.quote ?? ''),
      note: candidate.note || undefined,
      tags: Array.isArray(candidate.tags) ? candidate.tags : undefined,
      verification: candidate.verification || undefined,
      segment_index: candidate.segment_index ?? undefined,
      end_segment_index: candidate.end_segment_index ?? undefined,
      speaker_label: candidate.speaker_label || undefined,
      start_ms: candidate.start_ms ?? undefined,
      end_ms: candidate.end_ms ?? undefined,
      anchored: candidate.anchored !== false,
      claim_summary: candidate.claim_summary || undefined,
      importance: candidate.importance ?? undefined,
      confidence: candidate.confidence ?? undefined,
      sensitivity: candidate.sensitivity || undefined,
      requires_validation: candidate.requires_validation === true,
      validation_methods: Array.isArray(candidate.validation_methods)
        ? candidate.validation_methods
        : undefined,
      comparison_potential: candidate.comparison_potential || undefined,
      quoted_from_another_person: candidate.quoted_from_another_person === true,
      referenced_people: Array.isArray(candidate.referenced_people)
        ? candidate.referenced_people
        : undefined,
      contains_interviewer_text: candidate.contains_interviewer_text === true,
      evidence_scope: candidate.evidence_scope || undefined,
      agreement_status: candidate.agreement_status || undefined,
      is_hypothetical_example: candidate.is_hypothetical_example === true,
      follow_up_required: candidate.follow_up_required === true,
      follow_up_action: candidate.follow_up_action || undefined,
      term_ids: Array.isArray(candidate.term_ids)
        ? candidate.term_ids
        : undefined,
      origin: 'ai',
      ai_meta: this.evidenceMeta(run, candidate),
    });
    return item.id;
  }

  /** Provenance plus whatever the model said that has no column. */
  private termMeta(
    run: AiExtractionRun,
    candidate: StoredCandidate,
  ): Record<string, unknown> {
    return {
      extraction_run_id: run.id,
      model: run.model,
      occurrence_count: candidate.occurrence_count,
      examples: candidate.examples,
      problems: candidate.problems,
      ...(candidate.raw ?? {}),
    };
  }

  private evidenceMeta(
    run: AiExtractionRun,
    candidate: StoredCandidate,
  ): Record<string, unknown> {
    return {
      extraction_run_id: run.id,
      model: run.model,
      coverage: candidate.coverage,
      claimed_segment_index: candidate.claimed_segment_index,
      segment_mismatch: candidate.segment_mismatch,
      problems: candidate.problems,
      ...(candidate.raw ?? {}),
    };
  }

  /**
   * Remember a turned-down candidate so the next run does not propose it again.
   *
   * Stored per project rather than per transcript: the same irrelevant name will
   * come up in the next interview too, and the reviewer already answered.
   */
  private async rememberRejection(
    run: AiExtractionRun,
    candidate: StoredCandidate,
  ): Promise<void> {
    const label =
      run.kind === ExtractionKind.GLOSSARY
        ? String(candidate.term ?? '').trim()
        : String(candidate.quote ?? '')
            .trim()
            .slice(0, REJECTION_LABEL_LIMIT);

    const fingerprint = fingerprintOf(label);
    if (!fingerprint) return;

    try {
      await this.rejectionRepo.save(
        this.rejectionRepo.create({
          project_id: run.project_id,
          transcription_id: run.transcription_id,
          kind: run.kind,
          fingerprint,
          label: label.slice(0, 512),
        }),
      );
    } catch {
      // Unique violation: already rejected once, which is the desired state.
    }
  }

  /**
   * `speaker_id` -> the real name of the person mapped to it.
   *
   * The transcript's own `speaker_label` stays anonymous ("گوینده ۱") for the
   * whole life of the recording — confirming speakers only rewrites
   * `final_text`. Without this map the model is handed anonymous labels and
   * writes them into every summary, so a finished evidence item says
   * "گوینده 1 توضیح می‌دهد…" instead of naming the person.
   */
  private async resolveSpeakerNames(
    transcription: Transcription,
  ): Promise<Record<string, string>> {
    const map = transcription.speaker_map ?? {};
    const personIds = Object.values(map).filter(
      (value): value is number => typeof value === 'number',
    );
    if (personIds.length === 0) return {};

    const persons = await this.personService.findByIds(personIds);
    const nameById = new Map(persons.map((person) => [person.id, person.name]));

    const names: Record<string, string> = {};
    Object.entries(map).forEach(([speakerId, personId]) => {
      const name = personId != null ? nameById.get(personId) : undefined;
      if (name) names[speakerId] = name;
    });
    return names;
  }

  private async loadRejections(
    projectId: number,
    kind: ExtractionKind,
  ): Promise<string[]> {
    const rows = await this.rejectionRepo.find({
      where: { project_id: projectId, kind },
      order: { created_at: 'DESC' },
      take: MAX_REJECTIONS_SENT,
    });
    return rows.map((row) => row.label);
  }

  /** A run without its candidate list, for list responses. */
  private strip(run: AiExtractionRun): AiExtractionRun {
    return { ...run, candidates: null };
  }
}
