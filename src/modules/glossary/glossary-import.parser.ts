/**
 * Parser for the bulk-import table of a project glossary.
 *
 * The expected input is the Markdown table a reviewer already writes by hand
 * (or gets out of an LLM):
 *
 * ```
 * | واژه رسمی | دسته | توضیح | شکل‌های دیگر | برچسب | وضعیت |
 * | :-- | :-- | :-- | :-- | :-- | :-- |
 * | قطران کاوه | شرکت‌ها | شرکت اصلی… | قطران، شرکت قطران | `سازمان-اصلی` | نیازمند تأیید |
 * ```
 *
 * Columns are matched by **header name**, not position, and both the Persian
 * headers and English equivalents are accepted. Only the term and the category
 * are required.
 */

export interface ParsedGlossaryRow {
  term: string;
  category_label: string;
  description?: string;
  aliases: string[];
  tags: string[];
  status?: string;
  /** 1-based line number in the input, for error reporting. */
  line: number;
}

export interface GlossaryParseResult {
  rows: ParsedGlossaryRow[];
  /** Lines that looked like data but could not be used. */
  problems: Array<{ line: number; reason: string; raw: string }>;
}

/** Header aliases -> canonical field. */
const HEADERS: Record<string, keyof ParsedGlossaryRow | 'ignore'> = {
  'واژه رسمی': 'term',
  واژه: 'term',
  عنوان: 'term',
  term: 'term',

  دسته: 'category_label',
  دسته‌بندی: 'category_label',
  category: 'category_label',

  توضیح: 'description',
  توضیحات: 'description',
  description: 'description',

  'شکل‌های دیگر': 'aliases',
  'شکل های دیگر': 'aliases',
  'اشکال دیگر': 'aliases',
  مترادف: 'aliases',
  aliases: 'aliases',

  برچسب: 'tags',
  برچسب‌ها: 'tags',
  tags: 'tags',

  وضعیت: 'status',
  status: 'status',
};

const normalizeHeader = (value: string) =>
  value
    .replace(/\u200c/g, '\u200c')
    .replace(/\*\*/g, '')
    .trim()
    .toLowerCase();

const isSeparatorRow = (cells: string[]) =>
  cells.length > 0 &&
  cells.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s/g, '')));

const splitRow = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

/** Values inside a cell may be separated by Persian or latin commas, or by "/". */
const splitList = (value?: string): string[] => {
  if (!value) return [];
  return [
    ...new Set(
      value
        .split(/[،,؛;/\n]+/)
        .map((item) => item.replace(/`/g, '').trim())
        .filter(Boolean),
    ),
  ];
};

const clean = (value?: string) => {
  const trimmed = (value ?? '').replace(/\*\*/g, '').trim();
  return trimmed === '-' || trimmed === '—' ? '' : trimmed;
};

export function parseGlossaryMarkdown(markdown: string): GlossaryParseResult {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const rows: ParsedGlossaryRow[] = [];
  const problems: GlossaryParseResult['problems'] = [];

  let columns: Array<keyof ParsedGlossaryRow | 'ignore'> | null = null;

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line.includes('|')) return;

    const cells = splitRow(line);
    if (cells.length < 2) return;
    if (isSeparatorRow(cells)) return;

    // The first table row that looks like a header defines the mapping.
    if (!columns) {
      const mapped = cells.map(
        (cell) => HEADERS[normalizeHeader(cell)] ?? 'ignore',
      );
      if (mapped.includes('term')) {
        columns = mapped;
        return;
      }
      problems.push({
        line: index + 1,
        reason: 'سرستون‌های جدول شناسایی نشد (ستون «واژه رسمی» لازم است)',
        raw: line,
      });
      return;
    }

    const record: Partial<Record<keyof ParsedGlossaryRow, string>> = {};
    cells.forEach((cell, position) => {
      const field = columns![position];
      if (!field || field === 'ignore') return;
      record[field] = cell;
    });

    const term = clean(record.term);
    if (!term) {
      problems.push({ line: index + 1, reason: 'واژه خالی است', raw: line });
      return;
    }

    const categoryLabel = clean(record.category_label);
    if (!categoryLabel) {
      problems.push({
        line: index + 1,
        reason: 'دسته‌بندی خالی است',
        raw: line,
      });
      return;
    }

    rows.push({
      term,
      category_label: categoryLabel,
      description: clean(record.description) || undefined,
      // The canonical spelling is never repeated as an alias.
      aliases: splitList(record.aliases).filter((alias) => alias !== term),
      tags: splitList(record.tags),
      status: clean(record.status) || undefined,
      line: index + 1,
    });
  });

  if (!columns) {
    problems.push({
      line: 0,
      reason: 'جدولی با سرستون «واژه رسمی» پیدا نشد',
      raw: '',
    });
  }

  return { rows, problems };
}
