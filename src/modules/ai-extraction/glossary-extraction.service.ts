import { Injectable, Logger } from '@nestjs/common';
import { GeminiService, LlmOutputBudgetError } from '../ai/gemini.service';
import { PromptService } from '../ai/prompt.service';
import { GlossaryTerm } from '../glossary/glossary.entity';
import { ProjectCategory } from '../project/project-category.entity';
import {
  buildFormMatcher,
  normalizeForCompare,
} from '../../common/utils/persian-text';
import {
  Segments,
  asText,
  budgetInstruction,
  buildTranscriptPayload,
  cleanList,
  clampNumber,
  fingerprintOf,
  itemsWithinBudget,
  parseJsonObject,
} from './extraction-common';

/**
 * Output budget: the model's maximum, not something conservative.
 *
 * On a real 847-turn interview the model returned 46 candidates and ~51k
 * characters; at 32k tokens the same call had already been cut off once. Billing
 * is per token actually produced, so a high ceiling costs nothing when the answer
 * is short and saves the entire run when it is long.
 */
const MAX_OUTPUT_TOKENS = 65535;

/**
 * Rough output cost of one glossary candidate in Persian, measured on a real run
 * (46 candidates in ~51k characters). Used only to size a degraded run.
 */
const TOKENS_PER_CANDIDATE = 500;
const TIMEOUT_MS = 10 * 60 * 1000;

/** Example mentions kept per candidate, matching the prompt's own limit. */
const MAX_EXAMPLES = 3;

export interface GlossaryCandidateMention {
  segment_index: number | null;
  speaker?: string;
  start_time?: string;
  end_time?: string;
  surface?: string;
  context?: string;
  /** Did we find this wording at the segment the model pointed at? */
  located: boolean;
}

export interface GlossaryCandidate {
  candidate_id: number;
  term: string;
  category: string;
  category_label: string;
  definition?: string;
  aliases: string[];
  tags: string[];
  importance: number | null;
  confidence: number | null;
  needs_review: boolean;
  review_note?: string | null;
  examples: GlossaryCandidateMention[];
  /** Lines the term (or one of its aliases) actually occurs in. */
  occurrence_count: number;
  /** An existing entry this would merge into, if the model missed it. */
  duplicate_of?: { id: number; term: string } | null;
  /** Verification failures worth showing the reviewer. */
  problems: string[];
  decision: 'pending' | 'accepted' | 'rejected';
  raw: Record<string, unknown>;
}

export interface GlossaryExtractionOutput {
  candidates: GlossaryCandidate[];
  warnings: string[];
  promptChars: number;
  responseChars: number;
  model: string;
}

/** The model's raw output: untrusted JSON, so every field is `unknown`. */
interface RawGlossaryCandidate {
  [key: string]: unknown;
}

interface RawMention {
  [key: string]: unknown;
}

export interface GlossaryExtractionInput {
  segments: Segments;
  categories: ProjectCategory[];
  existingTerms: GlossaryTerm[];
  projectContext?: string | null;
  interviewerSpeakerIds?: string[] | null;
  /** Candidates the reviewer already turned down, by label. */
  rejectedLabels: string[];
}

/**
 * "واژه‌یابی" — ask the model which project-specific terms in this transcript
 * deserve a place in the glossary, then check every proposal against the text
 * before a human ever sees it.
 *
 * The verification step is the reason this is a service and not a single API
 * call. The model is good at judging what matters and bad at bookkeeping: it
 * points at the wrong line, proposes something the glossary already covers under
 * an alias, or offers a term that does not literally occur in the transcript. All
 * three are cheap to detect here and expensive to discover after the fact.
 */
@Injectable()
export class GlossaryExtractionService {
  private readonly logger = new Logger(GlossaryExtractionService.name);

  constructor(
    private readonly gemini: GeminiService,
    private readonly prompts: PromptService,
  ) {}

  isConfigured(): boolean {
    return this.gemini.isConfigured();
  }

  async extract(
    input: GlossaryExtractionInput,
  ): Promise<GlossaryExtractionOutput> {
    const { json: transcriptJson, lines } = buildTranscriptPayload(
      input.segments,
      input.interviewerSpeakerIds,
    );

    const user = this.buildUserMessage(input, transcriptJson);
    const notes: string[] = [];

    let raw: string;
    try {
      raw = await this.ask(user, MAX_OUTPUT_TOKENS);
    } catch (error) {
      if (!(error instanceof LlmOutputBudgetError)) throw error;

      // The key cannot afford a full answer. Rather than failing, ask for the
      // few most important terms in a response that actually fits.
      const budget = error.affordableTokens;
      const cap = itemsWithinBudget(budget, TOKENS_PER_CANDIDATE);
      this.logger.warn(
        `Glossary extraction degraded to ${cap} candidate(s) to fit ${budget} output tokens`,
      );
      notes.push(
        `اعتبار سرویس هوش مصنوعی محدود بود، پس فقط تا ${cap} واژه مهم درخواست شد. ` +
          `برای فهرست کامل، اعتبار کلید را افزایش دهید.`,
      );
      raw = await this.ask(user + budgetInstruction(budget, cap), budget);
    }

    const parsed = this.parse(raw);
    const proposed = (
      Array.isArray(parsed?.new_terms) ? parsed.new_terms : []
    ) as RawGlossaryCandidate[];

    const candidates = this.verify(proposed, input, lines);

    this.logger.log(
      `Glossary extraction: ${proposed.length} proposed -> ${candidates.length} after verification`,
    );

    return {
      candidates,
      warnings: [...notes, ...cleanList(parsed?.warnings)],
      promptChars: user.length,
      responseChars: raw.length,
      model: this.gemini.model,
    };
  }

  private ask(user: string, maxOutputTokens: number): Promise<string> {
    return this.gemini.complete({
      system: this.prompts.get('glossaryExtraction'),
      user,
      temperature: 0.2,
      maxOutputTokens,
      timeoutMs: TIMEOUT_MS,
      json: true,
    });
  }

  // ---------------------------------------------------------------------------

  /**
   * Parse the response, logging its tail when it fails. A malformed extraction
   * response is almost always a truncation or a stray wrapper, and both are
   * invisible from the error alone — the last few hundred characters say which.
   */
  private parse(raw: string): Record<string, unknown> {
    try {
      return parseJsonObject(raw);
    } catch (error) {
      this.logger.error(
        `Glossary extraction response unusable (${raw.length} chars). Tail: ${raw.slice(-400)}`,
      );
      throw error;
    }
  }

  private buildUserMessage(
    input: GlossaryExtractionInput,
    transcriptJson: string,
  ): string {
    const parts: string[] = [];

    if (input.projectContext?.trim()) {
      parts.push(
        `project_context:\n${JSON.stringify(input.projectContext.trim())}`,
      );
    }

    parts.push(
      `allowed_categories:\n${JSON.stringify(
        input.categories.map((category) => ({
          key: category.key,
          label: category.label,
        })),
      )}`,
    );

    parts.push(
      `existing_glossary:\n${JSON.stringify(
        input.existingTerms.map((term) => ({
          term: term.term,
          category: term.category,
          definition: term.description ?? undefined,
          aliases: term.aliases ?? [],
          tags: term.tags ?? [],
        })),
      )}`,
    );

    // Rejections are not part of the prompt contract, so they are given as a
    // plain instruction rather than smuggled into `existing_glossary` — that
    // would make them look like accepted knowledge.
    if (input.rejectedLabels.length > 0) {
      parts.push(
        'previously_rejected (the reviewer has already declined these; do not propose them again):\n' +
          JSON.stringify(input.rejectedLabels),
      );
    }

    parts.push(`transcript:\n${transcriptJson}`);

    return parts.join('\n\n');
  }

  /**
   * Check each proposal against the transcript and the existing glossary.
   *
   * Nothing is silently dropped except a proposal with no usable term at all:
   * the reviewer decides, and a flagged candidate with an explanation is more
   * useful than a missing one.
   */
  private verify(
    proposed: RawGlossaryCandidate[],
    input: GlossaryExtractionInput,
    lines: Array<{ segment_index: number; text: string; speaker: string }>,
  ): GlossaryCandidate[] {
    const categoryByKey = new Map(
      input.categories.map((category) => [category.key, category]),
    );
    const categoryByLabel = new Map(
      input.categories.map((category) => [
        normalizeForCompare(category.label),
        category,
      ]),
    );
    const fallbackCategory =
      categoryByKey.get('other') ??
      input.categories[input.categories.length - 1];

    // Every wording the project already knows, canonical or alias.
    const knownForms = new Map<string, GlossaryTerm>();
    input.existingTerms.forEach((term) => {
      [term.term, ...(term.aliases ?? [])].forEach((form) => {
        const key = normalizeForCompare(form);
        if (key) knownForms.set(key, term);
      });
    });

    const rejected = new Set(input.rejectedLabels.map(fingerprintOf));
    const seen = new Set<string>();
    const byIndex = new Map(lines.map((line) => [line.segment_index, line]));

    const candidates: GlossaryCandidate[] = [];

    proposed.forEach((item) => {
      const term = asText(item?.term);
      if (!term) return;

      const fingerprint = fingerprintOf(term);
      if (!fingerprint) return;

      // Duplicates inside one response: the prompt forbids them, but the check
      // is one line and the alternative is two identical rows in the wizard.
      if (seen.has(fingerprint)) return;
      seen.add(fingerprint);

      if (rejected.has(fingerprint)) return;

      const problems: string[] = [];

      const rawCategory = asText(item?.category);
      const category =
        categoryByKey.get(rawCategory) ??
        categoryByLabel.get(normalizeForCompare(rawCategory)) ??
        fallbackCategory;
      if (!categoryByKey.has(rawCategory)) {
        problems.push(
          `دسته «${rawCategory || '—'}» شناسایی نشد؛ «${category?.label}» پیشنهاد شد`,
        );
      }

      const aliases = cleanList(item?.aliases).filter(
        (alias) => normalizeForCompare(alias) !== fingerprint,
      );

      // Did the model propose something the glossary already covers?
      const duplicate =
        knownForms.get(fingerprint) ??
        aliases
          .map((alias) => knownForms.get(normalizeForCompare(alias)))
          .find(Boolean) ??
        null;
      if (duplicate) {
        problems.push(
          `این واژه از قبل با نام «${duplicate.term}» در دیکشنری هست؛ تأیید، آن را تکمیل می‌کند`,
        );
      }

      // Does the term actually occur in the text? This is the check that catches
      // an invented official name, which the prompt forbids but cannot prevent.
      const occurrences = this.countOccurrences([term, ...aliases], lines);
      if (occurrences === 0) {
        problems.push(
          'هیچ‌کدام از شکل‌های این واژه در متن پیدا نشد؛ ممکن است ساخته شده باشد',
        );
      }

      const examples = this.verifyMentions(item?.mentions, byIndex);
      if (examples.length > 0 && !examples.some((mention) => mention.located)) {
        problems.push('نمونه‌های ارجاع مدل روی خط‌های اعلام‌شده پیدا نشد');
      }

      candidates.push({
        candidate_id: candidates.length + 1,
        term,
        category: category?.key ?? 'other',
        category_label: category?.label ?? 'سایر',
        definition: asText(item?.definition) || undefined,
        aliases,
        tags: cleanList(item?.tags).slice(0, 5),
        importance: clampNumber(item?.importance, 1, 5),
        confidence: clampNumber(item?.confidence, 0, 1),
        // Our own checks can raise the flag even when the model was confident.
        needs_review: item?.needs_review === true || problems.length > 0,
        review_note: asText(item?.review_note) || null,
        examples,
        occurrence_count: occurrences,
        duplicate_of: duplicate
          ? { id: duplicate.id, term: duplicate.term }
          : null,
        problems,
        decision: 'pending',
        raw: this.leftovers(item),
      });
    });

    return candidates;
  }

  /** Number of distinct lines any of these wordings appears in. */
  private countOccurrences(
    forms: string[],
    lines: Array<{ text: string }>,
  ): number {
    const matcher = buildFormMatcher(
      forms.map((form) => ({ form, value: true })),
    );
    if (!matcher) return 0;

    let count = 0;
    lines.forEach((line) => {
      matcher.regex.lastIndex = 0;
      if (matcher.regex.test(line.text)) count += 1;
    });
    return count;
  }

  /**
   * Confirm the model's example mentions. A mention is "located" when the quoted
   * surface really is in the line it claims — the reviewer uses these to judge
   * identity, so a wrong pointer is worse than no pointer.
   */
  private verifyMentions(
    mentions: unknown,
    byIndex: Map<number, { text: string }>,
  ): GlossaryCandidateMention[] {
    if (!Array.isArray(mentions)) return [];

    return (mentions as RawMention[]).slice(0, MAX_EXAMPLES).map((mention) => {
      const index = Number(mention?.segment_index);
      const surface = asText(mention?.surface);
      const line = Number.isInteger(index) ? byIndex.get(index) : undefined;

      let located = false;
      if (line && surface) {
        const matcher = buildFormMatcher([{ form: surface, value: true }]);
        if (matcher) {
          matcher.regex.lastIndex = 0;
          located = matcher.regex.test(line.text);
        }
      }

      return {
        segment_index: Number.isInteger(index) ? index : null,
        speaker: asText(mention?.speaker) || undefined,
        start_time: asText(mention?.start_time) || undefined,
        end_time: asText(mention?.end_time) || undefined,
        surface: surface || undefined,
        context: asText(mention?.context) || undefined,
        located,
      };
    });
  }

  /** Fields the model returned that we don't map to a column. */
  private leftovers(item: RawGlossaryCandidate): Record<string, unknown> {
    const known = new Set([
      'term',
      'category',
      'definition',
      'aliases',
      'tags',
      'importance',
      'confidence',
      'needs_review',
      'review_note',
      'mentions',
    ]);
    const rest: Record<string, unknown> = {};
    Object.keys(item ?? {}).forEach((key) => {
      if (!known.has(key)) rest[key] = item[key];
    });
    return rest;
  }
}
