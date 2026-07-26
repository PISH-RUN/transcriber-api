/**
 * Parser for the bulk-import document of an evidence basket.
 *
 * The expected input is the Markdown a reviewer already writes per passage:
 *
 * ```
 * ### شاهد ۲: گستره صادرات
 *
 * **بازه زمانی:** ۰۱:۵۴ تا ۰۳:۱۴ **نوع شاهد:** عدد یا داده کمی
 *
 * **متن انتخابی:**
 * > «شرکت قطران، خب، ساختار اصلیش صادراته…»
 *
 * **توضیح بازبین:**
 * > علیرضا ساختار اصلی قطران را صادراتی معرفی می‌کند…
 *
 * **برچسب‌ها:**
 * * `گوینده:علیرضا-احسانی`
 * * `اعتبارسنجی:لازم`
 * ```
 *
 * A passage may instead give **شروع انتخاب** and **پایان انتخاب** blockquotes,
 * which mark a stretch of conversation rather than a single line.
 *
 * Labelled tags (`key:value`) are lifted into real fields where they have one —
 * `گوینده:` becomes the speaker and `اعتبارسنجی:` the verification state — and
 * the rest stay as plain tags.
 */

export interface ParsedEvidenceItem {
  title?: string;
  type_label?: string;
  /** Whole passage in one piece. */
  quote?: string;
  /** …or the two ends of a range. */
  start_anchor?: string;
  end_anchor?: string;
  note?: string;
  tags: string[];
  speaker_label?: string;
  verification?: string;
  /** "01:54" / "03:14" as written, converted to ms by the caller. */
  start_time?: string;
  end_time?: string;
  line: number;
}

export interface EvidenceParseResult {
  items: ParsedEvidenceItem[];
  problems: Array<{ line: number; reason: string; raw: string }>;
}

/** Persian digits -> ASCII, so "۰۱:۵۴" can be read as a time. */
const toAsciiDigits = (value: string) =>
  value.replace(/[۰-۹٠-٩]/g, (digit) => {
    const persian = '۰۱۲۳۴۵۶۷۸۹'.indexOf(digit);
    if (persian >= 0) return String(persian);
    return String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit));
  });

/**
 * Strip the Markdown around a quoted passage: blockquote markers, bold markers,
 * the guillemets a Persian writer wraps a quote in, and the ellipsis that marks
 * a passage continuing beyond the excerpt. Order matters — the markers have to
 * go before the surrounding punctuation can be recognised as surrounding.
 */
const stripQuoteChrome = (value: string) =>
  value
    .replace(/\*\*/g, '')
    .replace(/^\s*>\s?/gm, '')
    .trim()
    .replace(/^[«"“'‘]+/, '')
    .replace(/[»"”'’]+$/, '')
    .replace(/^\s*[.。…]{2,}\s*/, '')
    .replace(/\s*[.。…]{2,}\s*$/, '')
    .trim();

const LABELS = {
  time: /(?:بازه\s*زمانی|زمان)\s*[:：]/,
  type: /نوع\s*شاهد\s*[:：]/,
  quote: /متن\s*(?:انتخابی|انتخاب‌شده)\s*[:：]/,
  startAnchor: /شروع\s*انتخاب\s*[:：]/,
  endAnchor: /پایان\s*انتخاب\s*[:：]/,
  note: /توضیح(?:\s*بازبین)?\s*[:：]/,
  tags: /برچسب(?:‌ها|\s*ها)?\s*[:：]/,
};

/** Read "۰۱:۵۴ تا ۰۳:۱۴" out of an inline label line. */
const parseTimes = (text: string): { start?: string; end?: string } => {
  const ascii = toAsciiDigits(text);
  const times = ascii.match(/\d{1,3}:\d{2}(?::\d{2})?/g);
  if (!times?.length) return {};
  return { start: times[0], end: times[1] };
};

const parseTags = (block: string[]): string[] =>
  block
    .flatMap((line) =>
      line
        .replace(/^\s*[*+-]\s*/, '')
        .split(/[،,؛;]+/)
        .map((tag) => tag.replace(/`/g, '').replace(/\*\*/g, '').trim()),
    )
    .filter(Boolean);

export function parseEvidenceMarkdown(markdown: string): EvidenceParseResult {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const items: ParsedEvidenceItem[] = [];
  const problems: EvidenceParseResult['problems'] = [];

  // Split the document into blocks, one per "### …" heading.
  const blocks: Array<{ heading: string; body: string[]; line: number }> = [];
  let current: { heading: string; body: string[]; line: number } | null = null;

  lines.forEach((rawLine, index) => {
    const heading = rawLine.match(/^\s{0,3}#{2,4}\s+(.*)$/);
    if (heading) {
      const title = heading[1].trim();
      // A document-level title ("سبد شواهد — بسته شماره ۱") is not a passage.
      const looksLikePassage = /شاهد|شواهد\s*\d|evidence/i.test(title);
      const isPackageHeading = /بسته|package/i.test(title);

      if (looksLikePassage && !isPackageHeading) {
        if (current) blocks.push(current);
        current = { heading: title, body: [], line: index + 1 };
        return;
      }
      if (current) {
        blocks.push(current);
        current = null;
      }
      return;
    }
    if (current) current.body.push(rawLine);
  });
  if (current) blocks.push(current);

  blocks.forEach((block) => {
    const item: ParsedEvidenceItem = { tags: [], line: block.line };

    // "شاهد ۲: گستره صادرات" -> title "گستره صادرات"
    const titleMatch = block.heading.match(/^\s*شاهد\s*[^:：]*[:：]\s*(.+)$/);
    item.title =
      (titleMatch ? titleMatch[1] : block.heading).trim() || undefined;

    /** Collect the lines that belong to a labelled section. */
    let section: keyof typeof LABELS | null = null;
    const buffers: Partial<Record<keyof typeof LABELS, string[]>> = {};

    block.body.forEach((rawLine) => {
      const line = rawLine.trim();
      if (line === '---') return;

      // A tag or a quoted line is content, never a label — otherwise the tag
      // `زمان:وضعیت-فعلی` would be read as a "بازه زمانی" label and would also
      // close the tag section, dropping whatever followed it.
      const isContentLine = /^\s{0,3}(?:[*+-]\s|>)/.test(rawLine);

      // A single line may carry two inline labels (time + type).
      let matchedLabel = false;
      (Object.keys(LABELS) as Array<keyof typeof LABELS>).forEach((key) => {
        if (isContentLine || matchedLabel) return;
        if (!LABELS[key].test(line)) return;

        matchedLabel = true;

        if (key === 'time' || key === 'type') {
          const times = parseTimes(line);
          if (times.start) item.start_time = times.start;
          if (times.end) item.end_time = times.end;

          const typeMatch = line.split(LABELS.type)[1];
          if (typeMatch) {
            item.type_label =
              typeMatch.replace(/\*\*/g, '').trim() || undefined;
          }
          section = null;
          return;
        }

        section = key;
        buffers[key] = buffers[key] ?? [];

        // Content may sit on the same line as the label — but "**متن انتخابی:**"
        // leaves only the closing bold marker behind, which is not content.
        const inline = line.split(LABELS[key])[1];
        if (inline && /[\p{L}\p{N}]/u.test(inline)) buffers[key].push(inline);
      });

      if (matchedLabel) return;
      if (!section) return;
      if (!line) return;
      buffers[section]!.push(rawLine);
    });

    if (buffers.quote) {
      const quote = stripQuoteChrome(buffers.quote.join('\n'));
      // An ellipsis in the middle of a quote means "text left out here". Read as
      // one string it can never match the transcript; read as the two ends of a
      // range it anchors exactly, and the full passage is recovered.
      item.quote = quote;
      const split = quote.split(/\s*(?:\.{3,}|…+)\s*/);
      if (split.length > 1 && split[0] && split[split.length - 1]) {
        item.start_anchor = split[0];
        item.end_anchor = split[split.length - 1];
      }
    }
    if (buffers.startAnchor)
      item.start_anchor = stripQuoteChrome(buffers.startAnchor.join('\n'));
    if (buffers.endAnchor)
      item.end_anchor = stripQuoteChrome(buffers.endAnchor.join('\n'));
    if (buffers.note) item.note = stripQuoteChrome(buffers.note.join('\n'));
    if (buffers.tags) {
      const tags: string[] = [];
      parseTags(buffers.tags).forEach((tag) => {
        const [key, ...rest] = tag.split(/[:：]/);
        const value = rest.join(':').trim();

        // Labelled tags that have a real home get lifted out of the tag list.
        if (value && /^گوینده$/.test(key.trim())) {
          item.speaker_label = value.replace(/-/g, ' ');
          return;
        }
        if (value && /^اعتبارسنجی$/.test(key.trim())) {
          item.verification = value;
          return;
        }
        tags.push(tag);
      });
      item.tags = [...new Set(tags)];
    }

    if (!item.quote && !(item.start_anchor && item.end_anchor)) {
      problems.push({
        line: block.line,
        reason: 'نه «متن انتخابی» دارد و نه جفت «شروع/پایان انتخاب»',
        raw: block.heading,
      });
      return;
    }

    items.push(item);
  });

  if (blocks.length === 0) {
    problems.push({
      line: 0,
      reason: 'هیچ بلوکی با سرتیتر «### شاهد …» پیدا نشد',
      raw: '',
    });
  }

  return { items, problems };
}
