import { Transcription } from '../transcription/transcription.entity';
import { normalizeForCompare } from '../../common/utils/persian-text';

export type Segments = NonNullable<Transcription['segments']>;

/** Diarization's placeholder speaker; those turns carry no attributable text. */
const UNKNOWN_SPEAKER = 'SPEAKER_UNKNOWN';

/**
 * Refuse absurdly large inputs rather than spending minutes and a lot of tokens
 * on a call that cannot succeed. Gemini 2.5 Flash has a 1M-token window, so this
 * is far above any real interview — it only catches corrupt data.
 */
const MAX_PAYLOAD_CHARS = 1_500_000;

export interface TranscriptLine {
  segment_index: number;
  speaker: string;
  /** Only present when the user has marked who the interviewers are. */
  role?: 'interviewer' | 'interviewee';
  start_time: string;
  end_time: string;
  text: string;
}

export interface TranscriptPayloadOptions {
  interviewerSpeakerIds?: string[] | null;
  /**
   * `speaker_id` -> the person's real name, from the confirmed speaker mapping.
   *
   * Necessary because `segments[].speaker_label` keeps the anonymous
   * "گوینده ۱" form for the whole life of the recording — only `final_text` ever
   * gets the real names. Handing the anonymous form to the model means it writes
   * "گوینده 1" into every summary it produces, which is useless in a report.
   */
  speakerNames?: Record<string, string>;
}

/** Display name of a segment's speaker: the mapped person, or the raw label. */
export function speakerNameOf(
  segment: Segments[number],
  speakerNames?: Record<string, string>,
): string {
  return (
    speakerNames?.[segment?.speaker_id ?? ''] || segment?.speaker_label || '؟'
  );
}

/**
 * The transcript as the prompts expect it: ordered segments carrying their real
 * `segment_index`.
 *
 * Empty and unattributable turns are dropped, but indexes are **never**
 * renumbered — every pointer the model returns is checked against these numbers,
 * and a renumbered payload would make each one silently wrong.
 */
export function buildTranscriptPayload(
  segments: Segments,
  options: TranscriptPayloadOptions = {},
): { lines: TranscriptLine[]; json: string } {
  const interviewers = new Set(options.interviewerSpeakerIds ?? []);
  const knowsRoles = interviewers.size > 0;

  const lines: TranscriptLine[] = [];
  segments.forEach((segment, index) => {
    const text = (segment?.text ?? '').trim();
    if (!text) return;
    if (segment.speaker_id === UNKNOWN_SPEAKER) return;

    lines.push({
      segment_index: index,
      speaker: speakerNameOf(segment, options.speakerNames),
      ...(knowsRoles
        ? {
            role: interviewers.has(segment.speaker_id)
              ? ('interviewer' as const)
              : ('interviewee' as const),
          }
        : {}),
      start_time: segment.start_time,
      end_time: segment.end_time,
      text,
    });
  });

  const json = JSON.stringify({ segments: lines });
  if (json.length > MAX_PAYLOAD_CHARS) {
    throw new Error(
      `متن رونویسی برای یک فراخوان بیش از حد بزرگ است (${json.length} کاراکتر)`,
    );
  }

  return { lines, json };
}

/**
 * Extract the JSON object out of a model response.
 *
 * Tolerant of code fences and stray prose, because that failure mode is common
 * and cheap to survive. A response that got cut off mid-object is reported as
 * such: truncation and "the model found nothing" look identical otherwise, and
 * the difference decides whether re-running would help.
 */
export function parseJsonObject(raw: string): Record<string, any> {
  const cleaned = String(raw ?? '')
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim();

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');

  const size = `طول پاسخ: ${cleaned.length} کاراکتر`;

  if (start === -1) {
    throw new Error(`پاسخ مدل هیچ شیء JSON نداشت (${size})`);
  }
  if (end <= start) {
    throw new Error(
      `پاسخ مدل ناقص برگشت و بسته نشد؛ احتمالاً به سقف توکن خروجی خورده است (${size})`,
    );
  }

  const body = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch (error: unknown) {
    // A raw newline or tab inside a string is the most common way a long answer
    // breaks, and it is fully repairable.
    try {
      return JSON.parse(escapeControlChars(body)) as Record<string, unknown>;
    } catch {
      /* fall through to the real error */
    }

    // A valid prefix that fails to parse at the very end is the signature of a
    // truncated response.
    const looksTruncated = !cleaned.trimEnd().endsWith('}');
    throw new Error(
      looksTruncated
        ? `پاسخ مدل ناقص برگشت؛ احتمالاً به سقف توکن خروجی خورده است (${size})`
        : `پاسخ مدل JSON معتبر نبود: ${errorMessage(error)} (${size})`,
    );
  }
}

/** Escape the control characters JSON forbids inside string literals. */
function escapeControlChars(json: string): string {
  const out: string[] = [];
  let inString = false;
  let escaped = false;

  for (const char of json) {
    if (escaped) {
      out.push(char);
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      out.push(char);
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      out.push(char);
      continue;
    }
    if (inString && char < ' ') {
      out.push(
        char === '\n'
          ? '\\n'
          : char === '\r'
            ? '\\r'
            : char === '\t'
              ? '\\t'
              : ' ',
      );
      continue;
    }
    out.push(char);
  }

  return out.join('');
}

/**
 * Recover the individual items of one array out of a response that JSON.parse
 * rejects as a whole.
 *
 * A single stray character in item 23 otherwise costs the entire run: these
 * responses run to 100k characters and take two and a half minutes of paid
 * inference, and the other 41 items in them are perfectly good. So the array is
 * split on brace depth (string-aware, so braces inside quoted Persian text do
 * not count) and each element is parsed on its own; the broken ones are the only
 * thing lost.
 */
export function salvageItems(
  raw: string,
  key: string,
): Record<string, unknown>[] {
  const keyAt = raw.indexOf(`"${key}"`);
  if (keyAt === -1) return [];

  const arrayAt = raw.indexOf('[', keyAt);
  if (arrayAt === -1) return [];

  const items: Record<string, unknown>[] = [];
  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let escaped = false;

  for (let i = arrayAt + 1; i < raw.length; i += 1) {
    const char = raw[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      if (depth === 0) objectStart = i;
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0 && objectStart !== -1) {
        const body = raw.slice(objectStart, i + 1);
        try {
          const parsed: unknown = JSON.parse(escapeControlChars(body));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            items.push(parsed as Record<string, unknown>);
          }
        } catch {
          /* this one item is lost; the rest are not */
        }
        objectStart = -1;
      }
    } else if (char === ']' && depth === 0) {
      break;
    }
  }

  return items;
}

/**
 * Which language the transcript is in, as a short code the prompt understands.
 *
 * Sent explicitly rather than left to the model: the prompt's own fallback chain
 * ends at English, and a transcript with a lot of Latin product names could tip
 * that guess the wrong way and produce an English glossary for a Persian project.
 */
export function dominantLanguage(text: string): string {
  const sample = text.slice(0, 40000);
  const persian = (sample.match(/[\u0600-\u06FF]/g) ?? []).length;
  const latin = (sample.match(/[A-Za-z]/g) ?? []).length;
  if (persian === 0 && latin === 0) return 'fa';
  return persian >= latin ? 'fa' : 'en';
}

/** Stable identity for de-duplication and for remembering a rejection. */
export function fingerprintOf(value: string): string {
  return normalizeForCompare(String(value ?? '')).slice(0, 255);
}

/**
 * Ask for an answer that fits a smaller output budget.
 *
 * Simply lowering `max_tokens` does not work: the model writes the same long
 * answer and it gets cut mid-object, which is a total loss — unparseable JSON is
 * worth less than four good items. So the ceiling and the instruction move
 * together, and valid JSON is declared more important than coverage.
 */
export function budgetInstruction(tokens: number, maxItems: number): string {
  return [
    '',
    'HARD OUTPUT BUDGET (overrides the volume guidance above):',
    `Your entire response must fit within ${tokens} tokens.`,
    `Return at most ${maxItems} items — the most important ones only.`,
    'Keep every free-text field to one short sentence, and omit optional prose fields when they add little.',
    'A shorter, valid JSON object is strictly better than a longer one that gets cut off.',
  ].join('\n');
}

/**
 * Items that fit in a token budget, given roughly how much one item costs.
 * A margin is kept for the wrapper object and the model's own overshoot.
 */
export function itemsWithinBudget(
  tokens: number,
  tokensPerItem: number,
): number {
  return Math.max(1, Math.floor((tokens * 0.8) / tokensPerItem));
}

/** Trimmed unique string list, or an empty array. */
export function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((item) => String(item ?? '').trim())
        .filter((item) => item.length > 0),
    ),
  ];
}

/** Clamp a model-supplied score into range, or null when unusable. */
export function clampNumber(
  value: unknown,
  min: number,
  max: number,
): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Read an untrusted JSON value as trimmed text.
 *
 * Anything that is not a primitive becomes an empty string rather than
 * "[object Object]": if the model puts an object where a sentence belongs, the
 * field should read as missing, not as garbage the reviewer has to clean up.
 */
export function asText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

/** Message of a thrown value, without assuming it is an Error. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'نامشخص';
}

/**
 * A candidate as it comes back out of the run's `jsonb` column.
 *
 * Both kinds share one shape with everything optional: the column is
 * deliberately schema-free (a prompt change must not need a migration), but the
 * code that reads it should still be type-checked, so the untyped JSON is cast
 * to this once and never touched as `any` again.
 */
export interface StoredCandidate {
  candidate_id: number;
  decision?: 'pending' | 'accepted' | 'rejected';
  created_id?: number;
  problems?: string[];
  raw?: Record<string, unknown>;

  // glossary
  term?: string;
  category?: string;
  definition?: string;
  aliases?: string[];
  tags?: string[];
  status?: string;
  importance?: number | null;
  confidence?: number | null;
  needs_review?: boolean;
  review_note?: string | null;
  status_key?: 'confirmed' | 'tentative' | 'disputed';
  occurrence_count?: number;
  examples?: unknown;
  /**
   * Set by the reviewer: this proposal is another wording of that existing term,
   * so accepting it must extend that entry instead of creating a new one.
   */
  attach_to_term_id?: number | null;

  // evidence
  title?: string;
  type?: string;
  quote?: string;
  note?: string | null;
  claim_summary?: string | null;
  term_ids?: number[];
  verification?: string | null;
  sensitivity?: string | null;
  requires_validation?: boolean;
  validation_methods?: string[];
  comparison_potential?: string | null;
  quoted_from_another_person?: boolean;
  referenced_people?: string[];
  contains_interviewer_text?: boolean;
  evidence_scope?: string | null;
  agreement_status?: string | null;
  is_hypothetical_example?: boolean;
  follow_up_required?: boolean;
  follow_up_action?: string | null;
  anchored?: boolean;
  coverage?: number | null;
  segment_index?: number | null;
  end_segment_index?: number | null;
  start_ms?: number | null;
  end_ms?: number | null;
  speaker_label?: string | null;
  claimed_segment_index?: number | null;
  segment_mismatch?: boolean;
}

/** "00:04:12" or "4:12" -> milliseconds. */
export function timeToMs(value: unknown): number | null {
  const text = asText(value);
  if (!text) return null;
  const parts = text.split(':').map((part) => parseInt(part, 10));
  if (parts.some((part) => Number.isNaN(part))) return null;
  if (parts.length === 3)
    return ((parts[0] * 60 + parts[1]) * 60 + parts[2]) * 1000;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  return null;
}
