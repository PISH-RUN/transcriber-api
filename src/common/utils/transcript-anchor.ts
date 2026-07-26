import { buildSingleMatcher } from './persian-text';

export interface AnchorSegment {
  text?: string;
  speaker_label?: string;
  start_ms?: number;
  end_ms?: number;
  speaker_id?: string;
}

export interface AnchorIndex {
  /** All segments joined with a newline, untouched. */
  text: string;
  /** Start offset of each segment inside `text`. */
  starts: number[];
  /** Which segment a global offset falls in. */
  segmentAt(offset: number): number;
}

/**
 * Build a searchable view of a transcript.
 *
 * A reviewer's quote often runs past the end of one speaker turn, so anchoring
 * has to happen against the whole conversation, not per line. The join keeps
 * every original character, and `starts` maps a hit back to the line it began
 * in — no normalization of the haystack, so nothing can drift.
 */
export function buildAnchorIndex(segments: AnchorSegment[]): AnchorIndex {
  const starts: number[] = [];
  let cursor = 0;
  const parts: string[] = [];

  segments.forEach((segment) => {
    const text = segment?.text ?? '';
    starts.push(cursor);
    parts.push(text);
    cursor += text.length + 1; // + the newline used as the separator
  });

  return {
    text: parts.join('\n'),
    starts,
    segmentAt(offset: number) {
      // Binary search for the last segment that starts at or before `offset`.
      let low = 0;
      let high = starts.length - 1;
      let found = 0;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (starts[mid] <= offset) {
          found = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      return found;
    },
  };
}

export interface AnchorHit {
  /** Segment the anchor starts in. */
  segmentIndex: number;
  /** Offset inside the joined transcript. */
  offset: number;
  length: number;
  /** How much of the requested anchor was actually matched (0..1). */
  coverage: number;
}

/**
 * Locate a quoted passage in the transcript.
 *
 * Reviewers tidy their quotes — they drop a word, fix punctuation, or trail off
 * with an ellipsis — so an all-or-nothing search fails too often to be useful.
 * The search therefore degrades: try the whole anchor, then progressively
 * shorter leading portions of it, down to `minChars`. `coverage` reports how
 * much matched, so the caller can decide what to trust.
 */
export function findAnchor(
  index: AnchorIndex,
  anchor: string,
  options: { minChars?: number; steps?: number } = {},
): AnchorHit | null {
  const cleaned = String(anchor ?? '').trim();
  if (!cleaned) return null;

  const minChars = options.minChars ?? 25;
  const steps = options.steps ?? 8;

  /** Length that actually matters: punctuation is ignored when matching. */
  const wordLength = (value: string) =>
    value.replace(/[^\p{L}\p{N}]/gu, '').length;

  if (wordLength(cleaned) < minChars) return null;

  const lengths: number[] = [cleaned.length];
  for (let step = 1; step < steps; step += 1) {
    const length = Math.round(cleaned.length * (1 - step / steps));
    if (length > 0) lengths.push(length);
  }

  for (const length of lengths) {
    // Never end mid-word: a truncated anchor must stop at a real boundary.
    let candidate = cleaned.slice(0, length);
    if (length < cleaned.length) {
      const trimmed = candidate.replace(/[\p{L}\p{N}]+$/u, '');
      if (wordLength(trimmed) >= minChars) candidate = trimmed;
    }
    if (wordLength(candidate) < minChars) continue;

    // Loose matching: reviewers keep the words of a passage but not its commas,
    // guillemets or ellipses, so punctuation must not decide the outcome.
    const regex = buildSingleMatcher(candidate, { loose: true });
    if (!regex) continue;

    regex.lastIndex = 0;
    const match = regex.exec(index.text);
    if (match) {
      return {
        segmentIndex: index.segmentAt(match.index),
        offset: match.index,
        length: match[0].length,
        coverage: candidate.length / cleaned.length,
      };
    }
  }

  return null;
}
