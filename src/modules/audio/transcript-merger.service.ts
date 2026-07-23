import { Injectable, Logger } from '@nestjs/common';
import { PyannoteSegment } from './pyannote.service';

/**
 * Soniox token with timestamp information
 */
export interface SonioxToken {
  text: string;
  start_ms: number;
  end_ms: number;
  speaker?: number; // Soniox speaker (ignored when Pyannote available)
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

/**
 * Service for merging Pyannote diarization with Soniox STT tokens.
 *
 * Strategy: Pyannote decides WHO is speaking (speaker boundaries), Soniox
 * decides the exact words and word boundaries. For each Soniox token we find
 * the Pyannote segment that contains the token's midpoint and attribute the
 * token to that speaker. Consecutive tokens with the same speaker are merged
 * into a single output segment, so speaker changes only happen at clean word
 * boundaries.
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

  /**
   * Build the pyannote-speaker-ID → display-number mapping that
   * `mergeTranscripts` would produce for the given diarization + tokens. Used
   * by speaker-sample generation so sample labels match transcript labels.
   */
  buildSpeakerNumberMap(
    diarization: PyannoteSegment[],
    tokens: SonioxToken[],
  ): Map<string, number> {
    const map = new Map<string, number>();

    if (
      !tokens ||
      tokens.length === 0 ||
      !diarization ||
      diarization.length === 0
    ) {
      const seen = new Set<string>();
      for (const seg of (diarization || []).sort((a, b) => a.start - b.start)) {
        if (seg.speaker === 'SPEAKER_UNKNOWN') continue;
        if (!seen.has(seg.speaker)) {
          seen.add(seg.speaker);
          map.set(seg.speaker, map.size + 1);
        }
      }
      return map;
    }

    const sortedDiarization = [...diarization].sort((a, b) => a.start - b.start);
    const sortedTokens = [...tokens].sort((a, b) => a.start_ms - b.start_ms);

    for (const token of sortedTokens) {
      if (token.text.trim().length === 0) continue;

      const midpointMs = token.end_ms
        ? (token.start_ms + token.end_ms) / 2
        : token.start_ms;
      const midpointSec = midpointMs / 1000;

      let speaker: string | null = null;
      for (const seg of sortedDiarization) {
        if (midpointSec >= seg.start && midpointSec <= seg.end) {
          speaker = seg.speaker;
          break;
        }
      }

      if (!speaker) {
        let minDist = Infinity;
        for (const seg of sortedDiarization) {
          const segMid = (seg.start + seg.end) / 2;
          const dist = Math.abs(midpointSec - segMid);
          if (dist < minDist) {
            minDist = dist;
            speaker = seg.speaker;
          }
        }
      }

      if (speaker && speaker !== 'SPEAKER_UNKNOWN' && !map.has(speaker)) {
        map.set(speaker, map.size + 1);
      }
    }

    return map;
  }

  formatTime(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds
      .toString()
      .padStart(2, '0')}`;
  }

  /**
   * Merge Pyannote diarization with Soniox tokens into speaker-attributed
   * segments.
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

    const sortedDiarization = [...diarization].sort((a, b) => a.start - b.start);
    const sortedTokens = [...tokens].sort((a, b) => a.start_ms - b.start_ms);

    const segments: MergedSegment[] = [];
    let currentSegment: MergedSegment | null = null;

    for (const token of sortedTokens) {
      const midpointMs = token.end_ms
        ? (token.start_ms + token.end_ms) / 2
        : token.start_ms;
      const midpointSec = midpointMs / 1000;

      // Find the pyannote segment that contains this token's midpoint.
      let speaker: string | null = null;
      for (const seg of sortedDiarization) {
        if (midpointSec >= seg.start && midpointSec <= seg.end) {
          speaker = seg.speaker;
          break;
        }
      }

      // Nearest-segment fallback.
      if (!speaker) {
        let minDist = Infinity;
        for (const seg of sortedDiarization) {
          const segMid = (seg.start + seg.end) / 2;
          const dist = Math.abs(midpointSec - segMid);
          if (dist < minDist) {
            minDist = dist;
            speaker = seg.speaker;
          }
        }
      }

      speaker = speaker || 'SPEAKER_UNKNOWN';

      if (!currentSegment || currentSegment.speaker_id !== speaker) {
        if (currentSegment) segments.push(currentSegment);
        currentSegment = {
          speaker_id: speaker,
          speaker_label: this.getSpeakerLabel(speaker),
          text: token.text,
          start_time: this.formatTime(token.start_ms),
          end_time: this.formatTime(token.end_ms || token.start_ms),
          start_ms: token.start_ms,
          end_ms: token.end_ms || token.start_ms,
        };
      } else {
        currentSegment.text += token.text;
        currentSegment.end_ms = token.end_ms || token.start_ms;
        currentSegment.end_time = this.formatTime(currentSegment.end_ms);
      }
    }

    if (currentSegment) segments.push(currentSegment);

    return this.mergeConsecutiveSameSpeaker(segments);
  }

  private mergeConsecutiveSameSpeaker(
    segments: MergedSegment[],
  ): MergedSegment[] {
    if (segments.length <= 1) return segments;

    const result: MergedSegment[] = [];
    for (const segment of segments) {
      if (result.length > 0) {
        const last = result[result.length - 1];
        if (last.speaker_id === segment.speaker_id) {
          last.text += segment.text;
          last.end_ms = segment.end_ms;
          last.end_time = this.formatTime(segment.end_ms);
          continue;
        }
      }
      result.push({ ...segment });
    }
    return result;
  }

  /**
   * Fallback merge that uses Soniox's own speaker numbers when Pyannote
   * diarization isn't available.
   */
  private mergeWithSonioxSpeakers(tokens: SonioxToken[]): MergedSegment[] {
    const segments: MergedSegment[] = [];
    let currentSegment: MergedSegment | null = null;

    for (const token of tokens) {
      const speaker =
        token.speaker !== undefined
          ? `SPEAKER_${token.speaker.toString().padStart(2, '0')}`
          : 'SPEAKER_00';

      if (!currentSegment || currentSegment.speaker_id !== speaker) {
        if (currentSegment) segments.push(currentSegment);
        currentSegment = {
          speaker_id: speaker,
          speaker_label: this.getSpeakerLabel(speaker),
          text: token.text,
          start_time: this.formatTime(token.start_ms),
          end_time: this.formatTime(token.end_ms || token.start_ms),
          start_ms: token.start_ms,
          end_ms: token.end_ms || token.start_ms,
        };
      } else {
        currentSegment.text += token.text;
        currentSegment.end_ms = token.end_ms || token.start_ms;
        currentSegment.end_time = this.formatTime(currentSegment.end_ms);
      }
    }

    if (currentSegment) segments.push(currentSegment);
    return segments;
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
}
