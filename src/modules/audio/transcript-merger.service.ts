import { Injectable, Logger } from '@nestjs/common';
import { PyannoteSegment } from './pyannote.service';

/**
 * Soniox token with timestamp information
 */
export interface SonioxToken {
  text: string;
  start_ms: number;
  end_ms: number;
  speaker?: number | string; // Soniox speaker (ignored when Pyannote available)
  language?: string;
}

/**
 * Merged segment with speaker attribution
 */
export interface MergedSegment {
  speaker_id: string; // e.g., "SPEAKER_00"
  speaker_label: string; // Display label e.g., "گوینده 1"
  text: string;
  start_time: string; // Formatted "MM:SS"
  end_time: string; // Formatted "MM:SS"
  start_ms: number;
  end_ms: number;
}

/** One whole word (all of its sub-word Soniox tokens) with its time span. */
interface WordUnit {
  text: string;
  start_ms: number;
  end_ms: number;
}

/** A word after speaker attribution. */
interface AttributedWord extends WordUnit {
  speaker: string;
  /** Share of the word's duration covered by the winning speaker (0..1). */
  confidence: number;
}

/** A maximal stretch of consecutive words assigned to the same speaker. */
interface SpeakerRun {
  speaker: string;
  words: AttributedWord[];
}

/**
 * A single-word run is only overridden when attribution was this uncertain.
 * Above the threshold we trust Pyannote, even for a one-word back-channel
 * ("بله", "آره") in the middle of someone else's turn — those are real.
 */
const WEAK_ATTRIBUTION_CONFIDENCE = 0.6;

const HAS_CONTENT = /[\p{L}\p{N}]/u;

/**
 * Service for merging Pyannote diarization with Soniox STT tokens.
 *
 * ## Why this is not a per-token loop
 *
 * Soniox returns *sub-word* tokens: for `stt-async-v4` on Persian audio the
 * average token is ~2 characters, and a new word is marked by a leading space
 * ("ب", "سم", " الله"). Attributing each token independently therefore lets a
 * Pyannote boundary land *inside* a word, which is what produced output like
 *
 *     گوینده 1: بل
 *     گوینده 2: ه باشه
 *
 * instead of "بله" / "باشه". On a real 50-minute meeting this happened at 225
 * of 973 segment boundaries.
 *
 * ## Strategy
 *
 * 1. Group tokens into whole words (leading whitespace starts a new word).
 * 2. Attribute each *word* to the Pyannote speaker with the largest time
 *    overlap over the word's full span — not the speaker at one instant.
 * 3. Group consecutive same-speaker words into segments, so a speaker change
 *    can only ever happen at a word boundary.
 * 4. Smooth out attribution noise: punctuation-only runs join the previous
 *    segment, and a single word that was attributed with low confidence
 *    between two runs of the same speaker is absorbed into them.
 */
@Injectable()
export class TranscriptMergerService {
  private readonly logger = new Logger(TranscriptMergerService.name);

  /**
   * Map to track sequential speaker numbering (reset per merge call). Ensures
   * speakers are numbered 1, 2, 3... by order of appearance regardless of the
   * raw pyannote IDs (SPEAKER_00, SPEAKER_01, SPEAKER_03, ...).
   */
  private speakerNumberMap: Map<string, number> = new Map();

  private resetSpeakerNumbering(): void {
    this.speakerNumberMap = new Map();
  }

  /**
   * Convert Pyannote speaker ID to a Persian label with sequential numbering.
   */
  getSpeakerLabel(speakerId: string): string {
    if (speakerId === 'SPEAKER_UNKNOWN') {
      return speakerId;
    }
    if (!this.speakerNumberMap.has(speakerId)) {
      this.speakerNumberMap.set(speakerId, this.speakerNumberMap.size + 1);
    }
    return `گوینده ${this.speakerNumberMap.get(speakerId)}`;
  }

  formatTime(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds
      .toString()
      .padStart(2, '0')}`;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Merge Pyannote diarization with Soniox tokens into speaker-attributed
   * segments. Speaker changes only happen at word boundaries.
   */
  mergeTranscripts(
    diarization: PyannoteSegment[],
    tokens: SonioxToken[],
  ): MergedSegment[] {
    if (!tokens || tokens.length === 0) {
      return [];
    }

    this.resetSpeakerNumbering();

    if (!diarization || diarization.length === 0) {
      return this.mergeWithSonioxSpeakers(tokens);
    }

    const runs = this.buildSpeakerRuns(diarization, tokens);
    const segments = runs
      .map((run) => this.runToSegment(run))
      .filter((segment): segment is MergedSegment => segment !== null);

    this.logger.log(
      `Merged ${tokens.length} tokens with ${diarization.length} pyannote ` +
        `segments into ${segments.length} speaker turns`,
    );

    return this.mergeConsecutiveSameSpeaker(segments);
  }

  /**
   * Build the pyannote-speaker-ID → display-number mapping that
   * `mergeTranscripts` produces for the given diarization + tokens. Used by
   * speaker-sample generation so sample labels match transcript labels.
   *
   * Runs the exact same attribution pipeline as `mergeTranscripts` — anything
   * else risks numbering the samples differently from the transcript.
   */
  buildSpeakerNumberMap(
    diarization: PyannoteSegment[],
    tokens: SonioxToken[],
  ): Map<string, number> {
    const map = new Map<string, number>();

    if (!tokens?.length || !diarization?.length) {
      // Fall back to diarization order.
      for (const segment of [...(diarization || [])].sort(
        (a, b) => a.start - b.start,
      )) {
        if (segment.speaker === 'SPEAKER_UNKNOWN') continue;
        if (!map.has(segment.speaker)) map.set(segment.speaker, map.size + 1);
      }
      return map;
    }

    for (const run of this.buildSpeakerRuns(diarization, tokens)) {
      if (run.speaker === 'SPEAKER_UNKNOWN') continue;
      if (!this.runHasContent(run)) continue;
      if (!map.has(run.speaker)) map.set(run.speaker, map.size + 1);
    }

    return map;
  }

  /**
   * Generate formatted raw text from merged segments.
   * Format: "گوینده 1 [00:00 - 00:05]: سلام..."
   */
  generateRawText(segments: MergedSegment[]): string {
    if (!segments || segments.length === 0) return '';

    const lines: string[] = [];
    for (const segment of segments) {
      if (segment.speaker_id === 'SPEAKER_UNKNOWN') continue;
      const cleanText = segment.text.replace(
        /[\s.,!?؟،؛:;'"()[\]{}«»\-_…]+/g,
        '',
      );
      if (cleanText.length === 0) continue;

      lines.push(
        `${segment.speaker_label} [${segment.start_time} - ${segment.end_time}]: ${segment.text.trim()}`,
      );
    }
    return lines.join('\n\n');
  }

  // ---------------------------------------------------------------------------
  // Word grouping
  // ---------------------------------------------------------------------------

  /**
   * Collapse sub-word Soniox tokens into whole words.
   *
   * Soniox marks a word start with leading whitespace on the token, so a token
   * without it continues the current word. Trailing punctuation ("." , "،")
   * carries no leading space and therefore stays attached to its word, which is
   * what we want — a lone full stop must not become its own speaker turn.
   */
  private buildWords(tokens: SonioxToken[]): WordUnit[] {
    const sorted = [...tokens].sort((a, b) => a.start_ms - b.start_ms);
    const words: WordUnit[] = [];
    let previousEndedWithSpace = false;

    for (const token of sorted) {
      const text = token.text ?? '';
      if (text === '') continue;

      const start = token.start_ms;
      const end = Math.max(token.end_ms || token.start_ms, token.start_ms);
      const startsWord = /^\s/.test(text) || previousEndedWithSpace;
      previousEndedWithSpace = /\s$/.test(text);

      const last = words[words.length - 1];
      if (!last || startsWord) {
        words.push({ text, start_ms: start, end_ms: end });
      } else {
        last.text += text;
        last.end_ms = Math.max(last.end_ms, end);
      }
    }

    return words;
  }

  // ---------------------------------------------------------------------------
  // Speaker attribution
  // ---------------------------------------------------------------------------

  private buildSpeakerRuns(
    diarization: PyannoteSegment[],
    tokens: SonioxToken[],
  ): SpeakerRun[] {
    const words = this.buildWords(tokens);
    const attributed = this.attributeWords(words, diarization);
    return this.smoothRuns(this.groupIntoRuns(attributed));
  }

  /**
   * Assign every word to the speaker covering most of its duration.
   *
   * Both inputs are sorted by start time, so a single forward cursor is enough:
   * a diarization segment that ends before the current word starts can never
   * overlap a later word either.
   */
  private attributeWords(
    words: WordUnit[],
    diarization: PyannoteSegment[],
  ): AttributedWord[] {
    const segments = [...diarization].sort((a, b) => a.start - b.start);
    const result: AttributedWord[] = [];
    let cursor = 0;

    for (const word of words) {
      const startSec = word.start_ms / 1000;
      const endSec = Math.max(word.end_ms / 1000, startSec);
      const duration = Math.max(endSec - startSec, 0.001);

      while (cursor < segments.length && segments[cursor].end < startSec) {
        cursor += 1;
      }

      const overlaps = new Map<string, number>();
      for (let i = cursor; i < segments.length; i += 1) {
        const segment = segments[i];
        if (segment.start > endSec) break;
        const overlap =
          Math.min(endSec, segment.end) - Math.max(startSec, segment.start);
        if (overlap > 0) {
          overlaps.set(
            segment.speaker,
            (overlaps.get(segment.speaker) ?? 0) + overlap,
          );
        }
      }

      let speaker: string | null = null;
      let best = 0;
      for (const [candidate, overlap] of overlaps) {
        if (overlap > best) {
          best = overlap;
          speaker = candidate;
        }
      }

      if (!speaker) {
        // No overlap at all (the word fell in a silence gap): fall back to the
        // nearest segment, and mark the attribution as unreliable.
        speaker = this.nearestSpeaker(segments, (startSec + endSec) / 2);
      }

      result.push({
        ...word,
        speaker: speaker ?? 'SPEAKER_UNKNOWN',
        confidence: Math.min(1, best / duration),
      });
    }

    return result;
  }

  private nearestSpeaker(
    segments: PyannoteSegment[],
    atSec: number,
  ): string | null {
    let nearest: string | null = null;
    let minDistance = Infinity;

    for (const segment of segments) {
      const distance =
        atSec < segment.start
          ? segment.start - atSec
          : atSec > segment.end
            ? atSec - segment.end
            : 0;
      if (distance < minDistance) {
        minDistance = distance;
        nearest = segment.speaker;
      }
    }

    return nearest;
  }

  private groupIntoRuns(words: AttributedWord[]): SpeakerRun[] {
    const runs: SpeakerRun[] = [];
    for (const word of words) {
      const last = runs[runs.length - 1];
      if (last && last.speaker === word.speaker) {
        last.words.push(word);
      } else {
        runs.push({ speaker: word.speaker, words: [word] });
      }
    }
    return runs;
  }

  /**
   * Remove attribution noise that survives word grouping:
   *
   * - a run with no letters or digits (a stray "." or "،") belongs to whoever
   *   was speaking before it;
   * - a single word attributed with low confidence, sitting between two runs of
   *   the same speaker, is that speaker's word.
   *
   * Confident single-word runs are left alone: short interjections from another
   * participant are a real feature of a multi-person meeting.
   */
  private smoothRuns(runs: SpeakerRun[]): SpeakerRun[] {
    if (runs.length <= 1) return runs;

    const result: SpeakerRun[] = [];

    for (let i = 0; i < runs.length; i += 1) {
      const run = runs[i];
      const previous = result[result.length - 1];
      const next = runs[i + 1];
      const hasContent = this.runHasContent(run);

      // Leading punctuation with nobody to attach it to: give it to whoever
      // speaks next, so no contentless run ever becomes its own turn.
      if (!hasContent && !previous && next) {
        next.words.unshift(...run.words);
        continue;
      }

      const absorbIntoPrevious =
        !!previous &&
        (!hasContent ||
          (run.words.length === 1 &&
            run.words[0].confidence < WEAK_ATTRIBUTION_CONFIDENCE &&
            !!next &&
            next.speaker === previous.speaker));

      if (absorbIntoPrevious) {
        previous.words.push(...run.words);
        continue;
      }

      // Same speaker as the previous surviving run (possible after an absorb).
      if (previous && previous.speaker === run.speaker) {
        previous.words.push(...run.words);
        continue;
      }

      result.push({ speaker: run.speaker, words: [...run.words] });
    }

    return result;
  }

  private runHasContent(run: SpeakerRun): boolean {
    return run.words.some((word) => HAS_CONTENT.test(word.text));
  }

  private runToSegment(run: SpeakerRun): MergedSegment | null {
    const text = run.words
      .map((word) => word.text)
      .join('')
      .trim();
    if (!text) return null;

    const start = run.words[0].start_ms;
    const end = Math.max(run.words[run.words.length - 1].end_ms, start);

    return {
      speaker_id: run.speaker,
      speaker_label: this.getSpeakerLabel(run.speaker),
      text,
      start_time: this.formatTime(start),
      end_time: this.formatTime(end),
      start_ms: start,
      end_ms: end,
    };
  }

  private mergeConsecutiveSameSpeaker(
    segments: MergedSegment[],
  ): MergedSegment[] {
    if (segments.length <= 1) return segments;

    const result: MergedSegment[] = [];
    for (const segment of segments) {
      const last = result[result.length - 1];
      if (last && last.speaker_id === segment.speaker_id) {
        const left = last.text.trim();
        const right = segment.text.trim();
        last.text = left && right ? `${left} ${right}` : left || right;
        last.end_ms = segment.end_ms;
        last.end_time = this.formatTime(segment.end_ms);
        continue;
      }
      result.push({ ...segment });
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Fallback: no diarization available
  // ---------------------------------------------------------------------------

  /**
   * Merge using Soniox's own per-token speaker numbers. Still word-based: a
   * word takes the speaker most of its tokens agree on, so the same mid-word
   * split cannot happen here either.
   */
  private mergeWithSonioxSpeakers(tokens: SonioxToken[]): MergedSegment[] {
    const sorted = [...tokens].sort((a, b) => a.start_ms - b.start_ms);
    const words: Array<WordUnit & { votes: Map<string, number> }> = [];
    let previousEndedWithSpace = false;

    const speakerOf = (token: SonioxToken) =>
      token.speaker !== undefined && token.speaker !== null
        ? `SPEAKER_${String(token.speaker).padStart(2, '0')}`
        : 'SPEAKER_00';

    for (const token of sorted) {
      const text = token.text ?? '';
      if (text === '') continue;

      const startsWord = /^\s/.test(text) || previousEndedWithSpace;
      previousEndedWithSpace = /\s$/.test(text);
      const end = Math.max(token.end_ms || token.start_ms, token.start_ms);
      const speaker = speakerOf(token);

      const last = words[words.length - 1];
      if (!last || startsWord) {
        words.push({
          text,
          start_ms: token.start_ms,
          end_ms: end,
          votes: new Map([[speaker, 1]]),
        });
      } else {
        last.text += text;
        last.end_ms = Math.max(last.end_ms, end);
        last.votes.set(speaker, (last.votes.get(speaker) ?? 0) + 1);
      }
    }

    const attributed: AttributedWord[] = words.map((word) => {
      let speaker = 'SPEAKER_00';
      let best = 0;
      let total = 0;
      for (const [candidate, votes] of word.votes) {
        total += votes;
        if (votes > best) {
          best = votes;
          speaker = candidate;
        }
      }
      return {
        text: word.text,
        start_ms: word.start_ms,
        end_ms: word.end_ms,
        speaker,
        confidence: total > 0 ? best / total : 0,
      };
    });

    const segments = this.smoothRuns(this.groupIntoRuns(attributed))
      .map((run) => this.runToSegment(run))
      .filter((segment): segment is MergedSegment => segment !== null);

    return this.mergeConsecutiveSameSpeaker(segments);
  }
}
