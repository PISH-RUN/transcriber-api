import { Injectable, Logger } from '@nestjs/common';
import { GeminiService, LlmOutputBudgetError } from '../ai/gemini.service';
import { PromptService } from '../ai/prompt.service';
import { EvidenceItem } from '../evidence/evidence.entity';
import {
  AGREEMENT_STATUSES as AGREEMENT_STATUS_VALUES,
  EVIDENCE_SCOPES as EVIDENCE_SCOPE_VALUES,
} from '../evidence/evidence.dto';
import { GlossaryTerm } from '../glossary/glossary.entity';
import { ProjectCategory } from '../project/project-category.entity';
import {
  normalizeForCompare,
  persianPatternFor,
} from '../../common/utils/persian-text';
import {
  buildAnchorIndex,
  findAnchor,
} from '../../common/utils/transcript-anchor';
import {
  Segments,
  asText,
  budgetInstruction,
  buildTranscriptPayload,
  cleanList,
  clampNumber,
  dominantLanguage,
  fingerprintOf,
  itemsWithinBudget,
  parseJsonObject,
  salvageItems,
  speakerNameOf,
  timeToMs,
} from './extraction-common';

/**
 * Evidence runs are the expensive ones: a two-hour interview can legitimately
 * yield 30–40 items, each with a quote plus seven prose fields. In Persian that
 * is tens of thousands of output tokens, so the budget is the model's maximum
 * rather than something conservative — a truncated response wastes the whole run.
 */
const MAX_OUTPUT_TOKENS = 65535;
const TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Rough output cost of one evidence candidate in Persian, measured on a real run
 * (54 candidates in ~120k characters). Used only to size a degraded run.
 */
const TOKENS_PER_CANDIDATE = 1100;

/** Below this, a located quote is treated as a partial match worth flagging. */
const RELIABLE_COVERAGE = 0.9;

/**
 * A located quote at (or above) this coverage is replaced with the transcript's
 * own words. The model is instructed to quote verbatim but still normalizes
 * punctuation; taking the real text guarantees the stored quote is exact.
 */
const VERBATIM_COVERAGE = 0.99;

/** Fixed vocabularies of the prompt; anything else is dropped, not stored. */
const EVIDENCE_SCOPES = new Set<string>(EVIDENCE_SCOPE_VALUES);
const AGREEMENT_STATUSES = new Set<string>(AGREEMENT_STATUS_VALUES);

const MEETING_TYPES = new Set([
  'interview',
  'presentation',
  'presentation_and_discussion',
  'project_kickoff',
  'workshop',
  'process_walkthrough',
  'management_meeting',
  'focus_group',
  'mixed',
  'unknown',
]);

const SENSITIVITIES = new Set([
  'normal',
  'internal',
  'sensitive_personnel',
  'sensitive_financial',
  'sensitive_legal',
  'sensitive_commercial',
]);

/**
 * The prompt lists its own fallback type keys, and the model sometimes reaches
 * for those even when the project's keys were supplied. They mean exactly the
 * same things, so translate instead of making the reviewer retype the type —
 * but only onto a key the project actually defines.
 */
const TYPE_ALIASES: Record<string, string> = {
  quantitative_data: 'quantitative',
  personal_opinion: 'opinion',
  historical_memory: 'historical',
  judgment_about_person_or_unit: 'judgment',
  causal_claim: 'causal',
  completed_action: 'action_taken',
  proposal: 'suggestion',
  example_or_event: 'example',
  reference_to_document_or_person: 'reference',
};

const VALIDATION_METHODS = new Set([
  'document',
  'system_data',
  'another_interview',
  'direct_observation',
  'audio_review',
  'external_primary_source',
  'technical_expert',
  'not_required',
]);

export interface EvidenceCandidate {
  candidate_id: number;
  title: string;
  type: string;
  type_label: string;
  quote: string;
  claim_summary?: string | null;
  note?: string | null;
  tags: string[];
  term_ids: number[];
  term_labels: string[];
  importance: number | null;
  confidence: number | null;
  requires_validation: boolean;
  validation_methods: string[];
  verification?: string | null;
  comparison_potential?: string | null;
  quoted_from_another_person: boolean;
  referenced_people: string[];
  contains_interviewer_text: boolean;
  sensitivity?: string | null;

  // --- prompt v2 classification -------------------------------------------
  evidence_scope?: string | null;
  agreement_status?: string | null;
  is_hypothetical_example: boolean;
  follow_up_required: boolean;
  follow_up_action?: string | null;

  // --- our own verification of where this actually sits -------------------
  anchored: boolean;
  coverage: number | null;
  segment_index: number | null;
  end_segment_index: number | null;
  start_ms: number | null;
  end_ms: number | null;
  speaker_label?: string | null;
  /** What the model said the first segment was, before we checked. */
  claimed_segment_index: number | null;
  /** True when the located position differs from the claimed one. */
  segment_mismatch: boolean;

  duplicate_of?: { id: number; title?: string | null } | null;
  problems: string[];
  decision: 'pending' | 'accepted' | 'rejected';
  raw: Record<string, unknown>;
}

export interface EvidenceExtractionOutput {
  candidates: EvidenceCandidate[];
  warnings: string[];
  coverage: Record<string, unknown> | null;
  /** What kind of session this was, as the model characterised it. */
  sourceCharacterization: { meeting_type: string; description?: string } | null;
  promptChars: number;
  responseChars: number;
  model: string;
}

/**
 * The model's own output shape. Every field is `unknown`: this is untrusted JSON
 * from outside the process, and typing it as such forces the coercion that the
 * verification step does anyway.
 */
interface RawEvidenceCandidate {
  source?: {
    start_segment_index?: unknown;
    end_segment_index?: unknown;
    start_time?: unknown;
    end_time?: unknown;
    speakers?: unknown;
    contains_interviewer_text?: unknown;
  };
  [key: string]: unknown;
}

export interface EvidenceExtractionInput {
  segments: Segments;
  types: ProjectCategory[];
  glossary: GlossaryTerm[];
  existingEvidence: EvidenceItem[];
  projectContext?: string | null;
  interviewerSpeakerIds?: string[] | null;
  /** `speaker_id` -> the confirmed person's real name. */
  speakerNames?: Record<string, string>;
  rejectedLabels: string[];
}

/**
 * "شواهد‌یابی" — ask the model which passages of this transcript are worth
 * keeping as evidence, then put every quote back where it came from.
 *
 * Anchoring is not a nicety here. An evidence item whose pointer is wrong is
 * worse than no item at all: it will be cited later against the wrong speaker at
 * the wrong minute. So the model's `segment_index` is treated as a hint, the
 * quote itself is searched for in the transcript, and a disagreement between the
 * two is surfaced instead of being resolved silently.
 */
@Injectable()
export class EvidenceExtractionService {
  private readonly logger = new Logger(EvidenceExtractionService.name);

  constructor(
    private readonly gemini: GeminiService,
    private readonly prompts: PromptService,
  ) {}

  isConfigured(): boolean {
    return this.gemini.isConfigured();
  }

  async extract(
    input: EvidenceExtractionInput,
  ): Promise<EvidenceExtractionOutput> {
    const { json: transcriptJson } = buildTranscriptPayload(input.segments, {
      interviewerSpeakerIds: input.interviewerSpeakerIds,
      speakerNames: input.speakerNames,
    });

    const user = this.buildUserMessage(input, transcriptJson);
    const notes: string[] = [];

    let raw: string;
    try {
      raw = await this.ask(user, MAX_OUTPUT_TOKENS);
    } catch (error) {
      if (!(error instanceof LlmOutputBudgetError)) throw error;

      // Degrade instead of failing: a handful of the strongest passages is worth
      // having, and the reviewer is told the list is deliberately short.
      const budget = error.affordableTokens;
      const cap = itemsWithinBudget(budget, TOKENS_PER_CANDIDATE);
      this.logger.warn(
        `Evidence extraction degraded to ${cap} candidate(s) to fit ${budget} output tokens`,
      );
      notes.push(
        `اعتبار سرویس هوش مصنوعی محدود بود، پس فقط تا ${cap} شاهد مهم درخواست شد. ` +
          `برای فهرست کامل، اعتبار کلید را افزایش دهید.`,
      );
      raw = await this.ask(user + budgetInstruction(budget, cap), budget);
    }

    const parsed = this.parse(raw, notes);
    const proposed = (
      Array.isArray(parsed?.evidence_candidates)
        ? parsed.evidence_candidates
        : []
    ) as RawEvidenceCandidate[];

    const candidates = this.verify(proposed, input);

    // The prompt caps importance 5 at roughly a quarter of the items. When the
    // model blows past that, the ranking has stopped separating anything, and the
    // reviewer should know before they trust the order.
    const top = candidates.filter((item) => item.importance === 5).length;
    if (candidates.length >= 8 && top > candidates.length * 0.35) {
      notes.push(
        `${top} مورد از ${candidates.length} شاهد اهمیت ۵ گرفته‌اند؛ ` +
          `رتبه‌بندی مدل در این اجرا متورم است و بهتر است خودتان اهمیت‌ها را بازبینی کنید.`,
      );
    }

    this.logger.log(
      `Evidence extraction: ${proposed.length} proposed -> ${candidates.length} kept ` +
        `(${candidates.filter((item) => item.anchored).length} anchored)`,
    );

    return {
      candidates,
      warnings: [...notes, ...cleanList(parsed?.warnings)],
      coverage:
        parsed?.coverage && typeof parsed.coverage === 'object'
          ? (parsed.coverage as Record<string, unknown>)
          : null,
      sourceCharacterization: this.readCharacterization(parsed),
      promptChars: user.length,
      responseChars: raw.length,
      model: this.gemini.model,
    };
  }

  // ---------------------------------------------------------------------------

  private ask(user: string, maxOutputTokens: number): Promise<string> {
    return this.gemini.complete({
      system: this.prompts.get('evidenceExtraction'),
      user,
      temperature: 0.2,
      maxOutputTokens,
      timeoutMs: TIMEOUT_MS,
      json: true,
    });
  }

  /**
   * What kind of session the model thinks this was.
   *
   * Worth keeping: a product pitch and a diagnostic interview should not be read
   * the same way later, and the prompt uses this to stop presentation material
   * from being taken as organizational fact.
   */
  private readCharacterization(
    parsed: Record<string, unknown>,
  ): { meeting_type: string; description?: string } | null {
    const raw = parsed?.source_characterization;
    if (!raw || typeof raw !== 'object') return null;

    const source = raw as Record<string, unknown>;
    const type = asText(source.meeting_type).toLowerCase();

    return {
      meeting_type: MEETING_TYPES.has(type) ? type : 'unknown',
      description: asText(source.description) || undefined,
    };
  }

  /**
   * Parse the response, salvaging what can be salvaged.
   *
   * Observed on a real run: 100k characters of good output thrown away because
   * one item somewhere in the middle was malformed. Item-by-item recovery turns
   * that from a lost run into a slightly shorter list plus a warning.
   */
  private parse(raw: string, notes: string[]): Record<string, unknown> {
    try {
      return parseJsonObject(raw);
    } catch (error) {
      this.logger.error(
        `Evidence extraction response unusable (${raw.length} chars). Tail: ${raw.slice(-400)}`,
      );

      const salvaged = salvageItems(raw, 'evidence_candidates');
      if (salvaged.length === 0) throw error;

      this.logger.warn(
        `Salvaged ${salvaged.length} evidence candidate(s) from an unparseable response`,
      );
      notes.push(
        `پاسخ مدل کامل خوانده نشد، ولی ${salvaged.length} شاهد از آن بازیابی شد. ` +
          `ممکن است چند مورد جا افتاده باشد؛ در صورت نیاز اجرا را تکرار کنید.`,
      );
      return { evidence_candidates: salvaged };
    }
  }

  private buildUserMessage(
    input: EvidenceExtractionInput,
    transcriptJson: string,
  ): string {
    const parts: string[] = [];

    // Stated explicitly: the prompt's own fallback chain ends at English.
    parts.push(
      `output_language:\n${JSON.stringify(dominantLanguage(transcriptJson))}`,
    );

    if (input.projectContext?.trim()) {
      parts.push(
        `project_context:\n${JSON.stringify(input.projectContext.trim())}`,
      );
    }

    parts.push(
      `allowed_evidence_types:\n${JSON.stringify(
        input.types.map((type) => ({ key: type.key, label: type.label })),
      )}`,
    );

    parts.push(
      `project_glossary:\n${JSON.stringify(
        input.glossary.map((term) => ({
          term: term.term,
          category: term.category,
          aliases: term.aliases ?? [],
        })),
      )}`,
    );

    // Only the identifying part of what is already saved: the full quotes would
    // double the prompt for no gain, and duplicate detection works on the claim.
    parts.push(
      `existing_evidence:\n${JSON.stringify(
        input.existingEvidence.map((item) => ({
          title: item.title ?? undefined,
          evidence_type: item.type,
          quote: (item.quote ?? '').slice(0, 300),
        })),
      )}`,
    );

    if (input.rejectedLabels.length > 0) {
      parts.push(
        'previously_rejected (the reviewer has already declined these passages; do not propose them again):\n' +
          JSON.stringify(input.rejectedLabels),
      );
    }

    if (input.interviewerSpeakerIds?.length) {
      parts.push(
        'Note: each transcript segment carries a `role` field. Segments marked `interviewer` are the interviewing side; apply section 5 (Interviewer Statements) to them.',
      );
    }

    parts.push(`transcript:\n${transcriptJson}`);

    return parts.join('\n\n');
  }

  private verify(
    proposed: RawEvidenceCandidate[],
    input: EvidenceExtractionInput,
  ): EvidenceCandidate[] {
    const typeByKey = new Map(input.types.map((type) => [type.key, type]));
    const typeByLabel = new Map(
      input.types.map((type) => [normalizeForCompare(type.label), type]),
    );

    const termByName = new Map<string, GlossaryTerm>();
    input.glossary.forEach((term) => {
      [term.term, ...(term.aliases ?? [])].forEach((form) => {
        const key = normalizeForCompare(form);
        if (key) termByName.set(key, term);
      });
    });

    const index = buildAnchorIndex(input.segments);
    const segments = input.segments;
    const speakerNames = input.speakerNames;
    const labelStripper = this.buildLabelStripper(segments, speakerNames);

    const existingFingerprints = new Set(
      input.existingEvidence.map((item) => this.quoteFingerprint(item.quote)),
    );
    const existingById = new Map(
      input.existingEvidence.map((item) => [
        this.quoteFingerprint(item.quote),
        item,
      ]),
    );

    const rejected = new Set(
      input.rejectedLabels.map((label) => this.quoteFingerprint(label)),
    );
    const seen = new Set<string>();

    const candidates: EvidenceCandidate[] = [];

    proposed.forEach((item) => {
      const quote = this.stripLabels(asText(item?.quote), labelStripper);
      if (!quote) return;

      const fingerprint = this.quoteFingerprint(quote);
      if (seen.has(fingerprint)) return;
      seen.add(fingerprint);
      if (rejected.has(fingerprint)) return;

      const problems: string[] = [];

      const rawType = asText(item?.evidence_type);
      const type =
        typeByKey.get(rawType) ??
        typeByKey.get(TYPE_ALIASES[rawType] ?? '') ??
        typeByLabel.get(normalizeForCompare(rawType));
      if (!type) {
        // Without a valid type the item cannot be stored at all, so it is kept
        // as a candidate the reviewer must retype rather than dropped.
        problems.push(
          `نوع شاهد «${rawType || '—'}» در تاکسونومی این پروژه نیست؛ باید انتخاب شود`,
        );
      }

      const claimed = Number(item?.source?.start_segment_index);
      const claimedIndex = Number.isInteger(claimed) ? claimed : null;

      const located = this.locate(quote, index, segments, speakerNames);
      if (!located.anchored) {
        problems.push(
          'نقل‌قول در متن رونویسی پیدا نشد؛ ممکن است مدل آن را بازنویسی کرده باشد',
        );
      } else if (
        located.coverage != null &&
        located.coverage < RELIABLE_COVERAGE
      ) {
        problems.push(
          `فقط ${Math.round(located.coverage * 100)}٪ از نقل‌قول در متن تطبیق یافت`,
        );
      }

      const mismatch =
        located.anchored &&
        claimedIndex != null &&
        located.segmentIndex != null &&
        claimedIndex !== located.segmentIndex;
      if (mismatch) {
        problems.push(
          `مدل خط ${claimedIndex + 1} را اعلام کرد ولی متن در خط ${
            (located.segmentIndex ?? 0) + 1
          } پیدا شد؛ خط واقعی ثبت می‌شود`,
        );
      }

      const duplicate = existingFingerprints.has(fingerprint)
        ? existingById.get(fingerprint)
        : null;
      if (duplicate) {
        problems.push('این نقل‌قول از قبل در سبد شواهد هست');
      }

      const validationMethods = cleanList(item?.validation_methods).filter(
        (method) => VALIDATION_METHODS.has(method),
      );
      const requiresValidation =
        item?.requires_validation === true &&
        !validationMethods.includes('not_required');

      const sensitivityRaw = asText(item?.sensitivity);
      const sensitivity = SENSITIVITIES.has(sensitivityRaw)
        ? sensitivityRaw
        : null;

      const scopeRaw = asText(item?.evidence_scope).toLowerCase();
      const scope = EVIDENCE_SCOPES.has(scopeRaw) ? scopeRaw : null;

      const agreementRaw = asText(item?.agreement_status).toLowerCase();
      const agreement = AGREEMENT_STATUSES.has(agreementRaw)
        ? agreementRaw
        : null;

      const hypothetical = item?.is_hypothetical_example === true;
      const followUpAction = asText(item?.follow_up_action);
      // The prompt asks for specifics; "بررسی شود" is not a follow-up. A stub is
      // dropped so the follow-up list stays a list of real next steps.
      const usableFollowUp =
        item?.follow_up_required === true && followUpAction.length >= 15;

      if (item?.follow_up_required === true && !usableFollowUp) {
        problems.push('اقدام بعدی مشخص نبود و ثبت نشد');
      }
      // An example dressed up as an organizational fact is the worst failure this
      // pipeline can produce, so it is surfaced rather than just stored.
      if (hypothetical) {
        problems.push('این مورد مثال فرضی است، نه گزارشی از وضع واقعی سازمان');
      }
      if (agreement === 'confirmed_agreement') {
        problems.push(
          'به‌عنوان «توافق قطعی» علامت خورده؛ ارزش یک بار تأیید دارد',
        );
      }

      // Glossary links: canonical terms only, and only ones this project has.
      const termIds: number[] = [];
      const termLabels: string[] = [];
      cleanList(item?.glossary_terms).forEach((name) => {
        const term = termByName.get(normalizeForCompare(name));
        if (term && !termIds.includes(term.id)) {
          termIds.push(term.id);
          termLabels.push(term.term);
        }
      });

      // Topics become tags, prefixed the way the reviewer already writes them by
      // hand so imported, hand-tagged and AI items stay filterable together.
      const topics = cleanList(item?.topics).slice(0, 4);
      const tags = topics.map((topic) => `موضوع:${topic}`);

      candidates.push({
        candidate_id: candidates.length + 1,
        title: asText(item?.title) || 'بدون عنوان',
        type: type?.key ?? '',
        type_label: type?.label ?? rawType,
        quote: located.quote,
        claim_summary: asText(item?.claim_summary) || null,
        note: asText(item?.reviewer_note) || null,
        tags,
        term_ids: termIds,
        term_labels: termLabels,
        importance: clampNumber(item?.importance, 1, 5),
        confidence: clampNumber(item?.confidence, 0, 1),
        requires_validation: requiresValidation,
        validation_methods: validationMethods,
        // The reviewer's own vocabulary for the same idea, kept in sync with
        // what bulk import writes into this field.
        verification: requiresValidation
          ? validationMethods.filter((m) => m !== 'not_required').join('، ') ||
            'لازم'
          : null,
        comparison_potential: asText(item?.comparison_potential) || null,
        quoted_from_another_person: item?.quoted_from_another_person === true,
        referenced_people: cleanList(item?.referenced_people),
        contains_interviewer_text:
          item?.source?.contains_interviewer_text === true,
        sensitivity,

        evidence_scope: scope,
        agreement_status: agreement,
        is_hypothetical_example: hypothetical,
        follow_up_required: usableFollowUp,
        follow_up_action: usableFollowUp ? followUpAction : null,

        anchored: located.anchored,
        coverage: located.coverage,
        segment_index: located.segmentIndex,
        end_segment_index: located.endSegmentIndex,
        start_ms: located.startMs ?? timeToMs(item?.source?.start_time),
        end_ms: located.endMs ?? timeToMs(item?.source?.end_time),
        speaker_label: located.speakerLabel ?? null,
        claimed_segment_index: claimedIndex,
        segment_mismatch: mismatch,

        duplicate_of: duplicate
          ? { id: duplicate.id, title: duplicate.title }
          : null,
        problems,
        decision: 'pending',
        raw: this.leftovers(item),
      });
    });

    return candidates;
  }

  /**
   * A matcher for the "گوینده 1:" prefixes the model writes into quotes.
   *
   * The prompt explicitly allows speaker labels inside a multi-segment quote for
   * readability, but those labels are metadata in our data model — they are not
   * in the segment text. Left in place they poison the anchor: on a real run this
   * alone dropped anchoring from 62 candidates to 10.
   *
   * Built from the transcript's own labels rather than a generic "word before a
   * colon" pattern, so a real colon inside speech is never mistaken for one.
   */
  private buildLabelStripper(
    segments: Segments,
    speakerNames?: Record<string, string>,
  ): RegExp | null {
    const labels = [
      ...new Set(
        [
          // Both forms: the anonymous label the data carries, and the person name
          // the model was actually given.
          ...segments.map((segment) => (segment?.speaker_label ?? '').trim()),
          ...Object.values(speakerNames ?? {}).map((name) => name.trim()),
        ].filter((label) => label.length > 1),
      ),
    ].sort((a, b) => b.length - a.length);

    const patterns = labels
      .map((label) => persianPatternFor(label))
      .filter((pattern): pattern is string => !!pattern);

    if (patterns.length === 0) return null;

    // Persian digit variants are handled by the compiled pattern, so "گوینده ۱"
    // and "گوینده 1" both match.
    return new RegExp(
      `(^|[\\n\\s])(?:${patterns.join('|')})\\s*[:：]\\s*`,
      'gu',
    );
  }

  private stripLabels(quote: string, stripper: RegExp | null): string {
    if (!stripper || !quote) return quote;
    stripper.lastIndex = 0;
    return quote.replace(stripper, '$1').trim();
  }

  /**
   * Find the quote in the transcript.
   *
   * Reuses the same anchoring the bulk import uses, so a passage behaves
   * identically whether it arrived from a Markdown file or from the model.
   */
  private locate(
    quote: string,
    index: ReturnType<typeof buildAnchorIndex>,
    segments: Segments,
    speakerNames?: Record<string, string>,
  ): {
    quote: string;
    anchored: boolean;
    coverage: number | null;
    segmentIndex: number | null;
    endSegmentIndex: number | null;
    startMs: number | null;
    endMs: number | null;
    speakerLabel: string | null;
  } {
    const hit = findAnchor(index, quote);

    if (!hit) {
      return {
        quote,
        anchored: false,
        coverage: null,
        segmentIndex: null,
        endSegmentIndex: null,
        startMs: null,
        endMs: null,
        speakerLabel: null,
      };
    }

    const stop = hit.offset + hit.length;
    const endSegment = index.segmentAt(Math.max(hit.offset, stop - 1));

    return {
      // At full coverage the transcript's own words are the safer copy; below
      // that the slice would be a truncated prefix, so the model's text stands.
      quote:
        hit.coverage >= VERBATIM_COVERAGE
          ? index.text.slice(hit.offset, stop).trim() || quote
          : quote,
      anchored: true,
      coverage: hit.coverage,
      segmentIndex: hit.segmentIndex,
      endSegmentIndex: endSegment > hit.segmentIndex ? endSegment : null,
      startMs: segments[hit.segmentIndex]?.start_ms ?? null,
      endMs: segments[endSegment]?.end_ms ?? null,
      // The person's name, not the anonymous label, so the stored item reads the
      // way a report needs it.
      speakerLabel: segments[hit.segmentIndex]
        ? speakerNameOf(segments[hit.segmentIndex], speakerNames)
        : null,
    };
  }

  /** Quotes are long; the normalized opening is enough to recognise one. */
  private quoteFingerprint(quote: string | null | undefined): string {
    return fingerprintOf(asText(quote).slice(0, 400));
  }

  private leftovers(item: RawEvidenceCandidate): Record<string, unknown> {
    const known = new Set([
      'title',
      'evidence_type',
      'source',
      'quote',
      'claim_summary',
      'reviewer_note',
      'topics',
      'glossary_terms',
      'importance',
      'confidence',
      'requires_validation',
      'validation_methods',
      'comparison_potential',
      'quoted_from_another_person',
      'referenced_people',
      'sensitivity',
      'evidence_scope',
      'agreement_status',
      'is_hypothetical_example',
      'follow_up_required',
      'follow_up_action',
    ]);
    const rest: Record<string, unknown> = {};
    Object.keys(item ?? {}).forEach((key) => {
      if (!known.has(key)) rest[key] = item[key];
    });
    // The parts of `source` we do not store as columns are still worth keeping.
    if (item?.source && typeof item.source === 'object') {
      rest.source = item.source;
    }
    return rest;
  }
}
