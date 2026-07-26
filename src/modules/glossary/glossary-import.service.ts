import { HttpException, Injectable, Logger } from '@nestjs/common';
import { GlossaryService } from './glossary.service';
import { GlossaryScanService, ScanResult } from './glossary-scan.service';
import {
  parseGlossaryMarkdown,
  ParsedGlossaryRow,
} from './glossary-import.parser';
import { ProjectCategoryKind } from '../project/project-category.entity';
import { ProjectCategoryService } from '../project/project-category.service';
import { normalizeForCompare } from '../../common/utils/persian-text';
import { ImportGlossaryDto } from './glossary.dto';

export interface GlossaryImportRow {
  term: string;
  category_label: string;
  category_key?: string;
  aliases: string[];
  tags: string[];
  status?: string;
  description?: string;
  /** What the import will do (or did) with this row. */
  action: 'create' | 'merge' | 'skip';
  reason?: string;
  line: number;
}

export interface GlossaryImportResult {
  dry_run: boolean;
  rows: GlossaryImportRow[];
  created: number;
  merged: number;
  skipped: number;
  /** Category labels in the file that the project doesn't define. */
  unknown_categories: string[];
  problems: Array<{ line: number; reason: string; raw: string }>;
  scan?: ScanResult;
}

/**
 * Bulk import of a project glossary from the Markdown table reviewers already
 * keep, optionally followed by a scan that finds every term in the transcripts.
 *
 * Everything runs through `GlossaryService.createTerm`, so bulk import obeys the
 * same rule as tagging by hand: a term that already exists is **extended**
 * (aliases and tags merged), never duplicated.
 */
@Injectable()
export class GlossaryImportService {
  private readonly logger = new Logger(GlossaryImportService.name);

  constructor(
    private readonly glossaryService: GlossaryService,
    private readonly scanService: GlossaryScanService,
    private readonly categoryService: ProjectCategoryService,
  ) {}

  async import(dto: ImportGlossaryDto): Promise<GlossaryImportResult> {
    const parsed = dto.markdown
      ? parseGlossaryMarkdown(dto.markdown)
      : { rows: this.rowsFromPayload(dto), problems: [] };

    if (parsed.rows.length === 0) {
      throw new HttpException(
        parsed.problems[0]?.reason ?? 'هیچ ردیف قابل واردکردنی پیدا نشد',
        400,
      );
    }

    const dryRun = dto.dry_run ?? false;

    // Resolve the Persian category labels of the file against this project's
    // own taxonomy. Labels are compared after Persian normalization, so
    // "شرکت‌ها" and "شرکت ها" are the same label.
    const categories = await this.categoryService.list(
      dto.project_id,
      ProjectCategoryKind.GLOSSARY,
    );
    const byLabel = new Map(
      categories.map((category) => [
        normalizeForCompare(category.label),
        category,
      ]),
    );
    const byKey = new Map(
      categories.map((category) => [category.key, category]),
    );

    const unknown = new Set<string>();
    const rows: GlossaryImportRow[] = [];

    for (const row of parsed.rows) {
      const label = row.category_label;
      let category =
        byLabel.get(normalizeForCompare(label)) ?? byKey.get(label.trim());

      if (!category && dto.create_missing_categories && !dryRun) {
        category = await this.categoryService.create({
          project_id: dto.project_id,
          kind: ProjectCategoryKind.GLOSSARY,
          label,
        });
        byLabel.set(normalizeForCompare(category.label), category);
        byKey.set(category.key, category);
      }

      if (!category) {
        unknown.add(label);
        rows.push({
          ...this.toRow(row),
          action: 'skip',
          reason: dto.create_missing_categories
            ? 'دسته‌بندی در پیش‌نمایش ساخته نمی‌شود'
            : 'دسته‌بندی در تاکسونومی این پروژه تعریف نشده است',
        });
        continue;
      }

      const existing = await this.glossaryService.findByNameInProject(
        dto.project_id,
        row.term,
      );

      rows.push({
        ...this.toRow(row),
        category_key: category.key,
        action: existing ? 'merge' : 'create',
      });
    }

    const result: GlossaryImportResult = {
      dry_run: dryRun,
      rows,
      created: rows.filter((row) => row.action === 'create').length,
      merged: rows.filter((row) => row.action === 'merge').length,
      skipped: rows.filter((row) => row.action === 'skip').length,
      unknown_categories: [...unknown],
      problems: parsed.problems,
    };

    const termIds: number[] = [];

    if (!dryRun) {
      for (const row of rows) {
        if (row.action === 'skip' || !row.category_key) continue;
        const saved = await this.glossaryService.createTerm({
          project_id: dto.project_id,
          term: row.term,
          category: row.category_key,
          aliases: row.aliases,
          tags: row.tags,
          description: row.description,
          status: row.status,
        });
        termIds.push(saved.id);
      }
      this.logger.log(
        `Glossary import into project ${dto.project_id}: ${result.created} created, ${result.merged} merged, ${result.skipped} skipped`,
      );
    }

    // The scan is what makes a bulk import immediately useful: it turns the
    // imported list into pointers inside the actual transcripts.
    const scanMode = dto.scan ?? 'none';
    if (scanMode !== 'none') {
      result.scan = await this.scanService.scan({
        projectId: dto.project_id,
        transcriptionId:
          scanMode === 'transcription' ? dto.transcription_id : null,
        // In a dry run no term ids exist yet, so the preview scans the whole
        // glossary — which is also what the user is about to end up with.
        termIds: dryRun ? undefined : termIds,
        dryRun,
      });
    }

    return result;
  }

  private toRow(row: ParsedGlossaryRow): Omit<GlossaryImportRow, 'action'> {
    return {
      term: row.term,
      category_label: row.category_label,
      aliases: row.aliases,
      tags: row.tags,
      status: row.status,
      description: row.description,
      line: row.line,
    };
  }

  /** Accept a structured payload as an alternative to the Markdown table. */
  private rowsFromPayload(dto: ImportGlossaryDto): ParsedGlossaryRow[] {
    return (dto.terms ?? []).map((term, index) => ({
      term: term.term,
      category_label: term.category,
      description: term.description,
      aliases: term.aliases ?? [],
      tags: term.tags ?? [],
      status: term.status,
      line: index + 1,
    }));
  }
}
