import { HttpException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EvidenceItem } from './evidence.entity';
import { EvidenceService } from './evidence.service';
import { ImportEvidenceDto } from './evidence.dto';
import {
  parseEvidenceMarkdown,
  ParsedEvidenceItem,
} from './evidence-import.parser';
import { Transcription } from '../transcription/transcription.entity';
import { ProjectCategoryKind } from '../project/project-category.entity';
import { ProjectCategoryService } from '../project/project-category.service';
import { normalizeForCompare } from '../../common/utils/persian-text';
import {
  buildAnchorIndex,
  findAnchor,
} from '../../common/utils/transcript-anchor';

export interface EvidenceImportRow {
  title?: string;
  type_label?: string;
  type_key?: string;
  quote: string;
  note?: string;
  tags: string[];
  speaker_label?: string;
  verification?: string;
  segment_index?: number;
  end_segment_index?: number;
  start_ms?: number;
  end_ms?: number;
  /** Located in the transcript? */
  anchored: boolean;
  /** How much of the quoted anchor actually matched (0..1). */
  coverage?: number;
  action: 'create' | 'skip';
  reason?: string;
  line: number;
}

export interface EvidenceImportResult {
  dry_run: boolean;
  rows: EvidenceImportRow[];
  created: number;
  skipped: number;
  anchored: number;
  unanchored: number;
  unknown_types: string[];
  problems: Array<{ line: number; reason: string; raw: string }>;
}

/**
 * Bulk import of an evidence basket from the Markdown a reviewer writes per
 * passage.
 *
 * Two things make this more than a parser:
 *
 * 1. **Anchoring.** Each quote is located in the transcript so the item points
 *    at a real line and timestamp. Passages given as "from here … to there" are
 *    resolved to a span of lines. Anchoring degrades gracefully (a tidied quote
 *    still matches) and reports coverage.
 * 2. **Honest failure.** A quote that cannot be located is still imported — the
 *    text is the valuable part — but flagged `anchored: false` so the UI can
 *    single those out instead of silently pointing at the wrong line.
 */
@Injectable()
export class EvidenceImportService {
  private readonly logger = new Logger(EvidenceImportService.name);

  constructor(
    @InjectRepository(EvidenceItem)
    private readonly evidenceRepo: Repository<EvidenceItem>,
    @InjectRepository(Transcription)
    private readonly transcriptionRepo: Repository<Transcription>,
    private readonly evidenceService: EvidenceService,
    private readonly categoryService: ProjectCategoryService,
  ) {}

  async import(dto: ImportEvidenceDto): Promise<EvidenceImportResult> {
    const parsed = parseEvidenceMarkdown(dto.markdown);
    if (parsed.items.length === 0) {
      throw new HttpException(
        parsed.problems[0]?.reason ?? 'هیچ شاهدی در متن پیدا نشد',
        400,
      );
    }

    const dryRun = dto.dry_run ?? false;

    const types = await this.categoryService.list(
      dto.project_id,
      ProjectCategoryKind.EVIDENCE,
    );
    const byLabel = new Map(
      types.map((type) => [normalizeForCompare(type.label), type]),
    );
    const byKey = new Map(types.map((type) => [type.key, type]));

    const transcription = await this.loadTranscription(dto.transcription_id);
    const index = transcription
      ? buildAnchorIndex(transcription.segments)
      : null;

    const unknown = new Set<string>();
    const rows: EvidenceImportRow[] = [];

    for (const item of parsed.items) {
      const label = item.type_label ?? '';
      const type =
        byLabel.get(normalizeForCompare(label)) ?? byKey.get(label.trim());

      if (!type) {
        unknown.add(label || '(بدون نوع)');
        rows.push({
          ...this.baseRow(item),
          quote: item.quote ?? item.start_anchor ?? '',
          anchored: false,
          action: 'skip',
          reason: label
            ? 'نوع شواهد در تاکسونومی این پروژه تعریف نشده است'
            : 'نوع شواهد در متن مشخص نشده است',
        });
        continue;
      }

      const located = this.locate(item, index, transcription);

      rows.push({
        ...this.baseRow(item),
        type_key: type.key,
        quote: located.quote,
        segment_index: located.segmentIndex,
        end_segment_index: located.endSegmentIndex,
        // A passage that could not be located still keeps the timestamps the
        // reviewer wrote down — enough to jump roughly to the right place.
        start_ms: located.startMs ?? this.timeToMs(item.start_time),
        end_ms: located.endMs ?? this.timeToMs(item.end_time),
        speaker_label: item.speaker_label ?? located.speakerLabel,
        anchored: located.anchored,
        coverage: located.coverage,
        action: 'create',
        reason: located.anchored
          ? undefined
          : 'متن در رونویسی پیدا نشد؛ بدون ارجاع ثبت می‌شود',
      });
    }

    const result: EvidenceImportResult = {
      dry_run: dryRun,
      rows,
      created: 0,
      skipped: rows.filter((row) => row.action === 'skip').length,
      anchored: rows.filter((row) => row.action === 'create' && row.anchored)
        .length,
      unanchored: rows.filter((row) => row.action === 'create' && !row.anchored)
        .length,
      unknown_types: [...unknown],
      problems: parsed.problems,
    };

    if (!dryRun) {
      for (const row of rows) {
        if (row.action === 'skip' || !row.type_key) continue;
        await this.evidenceService.create({
          project_id: dto.project_id,
          transcription_id: dto.transcription_id,
          type: row.type_key,
          title: row.title,
          quote: row.quote,
          note: row.note,
          tags: row.tags,
          segment_index: row.segment_index,
          end_segment_index: row.end_segment_index,
          speaker_label: row.speaker_label,
          start_ms: row.start_ms,
          end_ms: row.end_ms,
          verification: row.verification,
          anchored: row.anchored,
        });
        result.created += 1;
      }
      this.logger.log(
        `Evidence import into project ${dto.project_id}: ${result.created} created ` +
          `(${result.anchored} anchored, ${result.unanchored} unanchored)`,
      );
    }

    return result;
  }

  // ---------------------------------------------------------------------------

  /**
   * Turn a parsed passage into a quote plus a pointer into the transcript.
   *
   * Order of preference: a full quote anchored on its own; a start/end pair
   * resolved to a span (the quote is then rebuilt from the real transcript
   * lines, which is more faithful than the reviewer's ellipsis); finally the
   * text as written with no pointer.
   */
  private locate(
    item: ParsedEvidenceItem,
    index: ReturnType<typeof buildAnchorIndex> | null,
    transcription: { segments: NonNullable<Transcription['segments']> } | null,
  ): {
    quote: string;
    anchored: boolean;
    coverage?: number;
    segmentIndex?: number;
    endSegmentIndex?: number;
    startMs?: number;
    endMs?: number;
    speakerLabel?: string;
  } {
    const fallbackQuote =
      item.quote ??
      [item.start_anchor, item.end_anchor].filter(Boolean).join(' … ');

    if (!index || !transcription) {
      return { quote: fallbackQuote, anchored: false };
    }

    const segments = transcription.segments;

    // Case 1: a range given by two anchors.
    if (item.start_anchor && item.end_anchor) {
      const start = findAnchor(index, item.start_anchor);
      const end = findAnchor(index, item.end_anchor);

      if (start && end && end.offset >= start.offset) {
        const stop = end.offset + end.length;
        const endSegment = index.segmentAt(Math.max(start.offset, stop - 1));
        return {
          // Rebuilt from the transcript between the two anchors: the real words,
          // starting where the reviewer's excerpt starts rather than at the
          // beginning of whatever speaker turn happens to contain it.
          quote: index.text.slice(start.offset, stop).trim(),
          anchored: true,
          coverage: Math.min(start.coverage, end.coverage),
          segmentIndex: start.segmentIndex,
          endSegmentIndex:
            endSegment > start.segmentIndex ? endSegment : undefined,
          startMs: segments[start.segmentIndex]?.start_ms,
          endMs: segments[endSegment]?.end_ms,
          speakerLabel: segments[start.segmentIndex]?.speaker_label,
        };
      }

      // Only one end resolved: still better than nothing.
      const single = start ?? end;
      if (single) {
        return {
          quote: fallbackQuote,
          anchored: true,
          coverage: single.coverage,
          segmentIndex: single.segmentIndex,
          startMs: segments[single.segmentIndex]?.start_ms,
          endMs: segments[single.segmentIndex]?.end_ms,
          speakerLabel: segments[single.segmentIndex]?.speaker_label,
        };
      }

      return { quote: fallbackQuote, anchored: false };
    }

    // Case 2: one quoted passage.
    if (item.quote) {
      const hit = findAnchor(index, item.quote);
      if (hit) {
        const endOffset = hit.offset + hit.length;
        const endSegment = index.segmentAt(Math.max(hit.offset, endOffset - 1));
        return {
          quote: item.quote,
          anchored: true,
          coverage: hit.coverage,
          segmentIndex: hit.segmentIndex,
          endSegmentIndex:
            endSegment > hit.segmentIndex ? endSegment : undefined,
          startMs: segments[hit.segmentIndex]?.start_ms,
          endMs: segments[endSegment]?.end_ms,
          speakerLabel: segments[hit.segmentIndex]?.speaker_label,
        };
      }
    }

    return { quote: fallbackQuote, anchored: false };
  }

  /** "01:54" or "1:02:03" -> milliseconds. */
  private timeToMs(value?: string): number | undefined {
    if (!value) return undefined;
    const parts = value.split(':').map((part) => parseInt(part, 10));
    if (parts.some((part) => Number.isNaN(part))) return undefined;
    const [a, b, c] = parts;
    if (parts.length === 3) return ((a * 60 + b) * 60 + c) * 1000;
    if (parts.length === 2) return (a * 60 + b) * 1000;
    return undefined;
  }

  private baseRow(
    item: ParsedEvidenceItem,
  ): Omit<EvidenceImportRow, 'quote' | 'anchored' | 'action'> {
    return {
      title: item.title,
      type_label: item.type_label,
      note: item.note,
      tags: item.tags,
      speaker_label: item.speaker_label,
      verification: item.verification,
      line: item.line,
    };
  }

  private async loadTranscription(
    id?: number,
  ): Promise<{ segments: NonNullable<Transcription['segments']> } | null> {
    if (!id) return null;
    const row = await this.transcriptionRepo
      .createQueryBuilder('t')
      .select(['t.id', 't.segments'])
      .where('t.id = :id', { id })
      .getOne();
    if (!row) throw new HttpException('رونویسی یافت نشد', 404);
    if (!Array.isArray(row.segments) || row.segments.length === 0) return null;
    return { segments: row.segments };
  }
}
