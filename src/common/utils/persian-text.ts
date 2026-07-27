/**
 * Flexible Persian text matching.
 *
 * ## Why not "normalize the haystack, then search"
 *
 * The obvious approach — fold the transcript into a canonical form and search
 * inside that — forces you to keep an index map so a hit can be translated back
 * to an offset in the real text. Glossary mentions store `start_offset` /
 * `end_offset` against the stored segment text, so a wrong map means a wrong
 * highlight.
 *
 * Instead we compile the *needle* into a pattern that tolerates every variation
 * we care about, and run it over the untouched text. Offsets are then exact by
 * construction.
 *
 * ## What the pattern tolerates
 *
 * - ZWNJ / ZWJ / zero-width spaces / tatweel / harakat anywhere between letters
 *   (`روغن‌پایه` ≡ `روغن پایه` ≡ `روغنپایه`)
 * - Arabic vs Persian letter forms: ي ى → ی, ك → ک, أ إ آ → ا, ة ۀ → ه, ؤ → و
 * - ASCII / Persian / Arabic-Indic digits as equivalents
 * - any run of whitespace where the term has a space
 * - latin case
 *
 * ## Word boundaries
 *
 * JavaScript's `\b` is ASCII-only, so `الیت` would match inside `فعالیت`. On the
 * real transcript that was 8 hits instead of 2. We use Unicode lookarounds
 * instead: a match may not be flanked by another letter or digit.
 */

/** Characters that carry no meaning for matching and may appear anywhere. */
const IGNORABLE_CLASS =
  '[\\u200b-\\u200f\\u0610-\\u061a\\u064b-\\u0652\\u0640\\u0670]*';

/** Letters that have several accepted spellings. */
const LETTER_VARIANTS: Record<string, string> = {
  ا: 'اآأإٱ',
  آ: 'اآأإٱ',
  أ: 'اآأإٱ',
  إ: 'اآأإٱ',
  ی: 'یيى',
  ي: 'یيى',
  ى: 'یيى',
  ک: 'کك',
  ك: 'کك',
  ه: 'هۀة',
  ۀ: 'هۀة',
  ة: 'هۀة',
  و: 'وؤ',
  ؤ: 'وؤ',
};

const DIGIT_GROUPS = [
  '0۰٠',
  '1۱١',
  '2۲٢',
  '3۳٣',
  '4۴٤',
  '5۵٥',
  '6۶٦',
  '7۷٧',
  '8۸٨',
  '9۹٩',
];

const DIGIT_VARIANTS: Record<string, string> = {};
DIGIT_GROUPS.forEach((group) => {
  [...group].forEach((digit) => {
    DIGIT_VARIANTS[digit] = group;
  });
});

const escapeForClass = (value: string) => value.replace(/[\]\\^-]/g, '\\$&');
const escapeLiteral = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * True for characters we drop entirely when comparing: zero-width marks,
 * tatweel and Arabic diacritics. Tested by code point rather than by a regex
 * character class — several of these are combining marks, and a literal class
 * containing them is genuinely misleading to read.
 */
const IGNORABLE_RANGES: Array<[number, number]> = [
  [0x200b, 0x200f], // ZWSP, ZWNJ, ZWJ, LRM, RLM
  [0x0610, 0x061a], // Arabic annotation signs
  [0x064b, 0x0652], // harakat
  [0x0640, 0x0640], // tatweel
  [0x0670, 0x0670], // superscript alef
];

const isIgnorable = (char: string) => {
  const code = char.codePointAt(0);
  if (code === undefined) return false;
  return IGNORABLE_RANGES.some(([from, to]) => code >= from && code <= to);
};

/**
 * Canonical form used for equality and de-duplication (not for searching).
 * Two strings that normalize to the same value are "the same wording".
 */
export function normalizeForCompare(value: string): string {
  let result = '';
  for (const char of String(value ?? '')) {
    if (isIgnorable(char)) continue;
    if (/\s/.test(char)) {
      if (!result.endsWith(' ')) result += ' ';
      continue;
    }
    const variants = LETTER_VARIANTS[char] ?? DIGIT_VARIANTS[char];
    // Represent a variant group by its first member, so all members collapse.
    result += variants ? variants[0] : char.toLowerCase();
  }
  return result.trim();
}

/**
 * Key for resolving a *match* back to the wording it belongs to.
 *
 * Whitespace is dropped on top of the usual normalization because the compiled
 * pattern treats a space in the term as optional: it happily finds
 * «روغن‌پایه» for «روغن پایه». Without this, that hit could not be resolved
 * back to its term and the scan discarded it — the tolerance in the pattern was
 * being undone one step later.
 */
const matchKey = (value: string): string =>
  normalizeForCompare(value).replace(/\s+/g, '');

/** Anything that is not a letter or a digit, in any quantity. */
const SEPARATOR_CLASS = '[^\\p{L}\\p{N}]*';

const isWordChar = (char: string) => /[\p{L}\p{N}]/u.test(char);

/**
 * Compile one wording into a regular-expression source that matches it in raw
 * text despite spelling and spacing variation.
 *
 * `loose` additionally treats every punctuation mark as an optional separator.
 * That is what long passages need: a reviewer copying a quote out of a
 * transcript keeps the words but rarely the commas, the ellipses or the
 * guillemets around them. For short glossary terms the strict form is used, so
 * punctuation inside a term still has to be there.
 */
export function persianPatternFor(
  form: string,
  options: { loose?: boolean } = {},
): string | null {
  const chars = [...String(form ?? '')].filter((char) => !isIgnorable(char));
  if (chars.length === 0) return null;

  const parts: string[] = [];
  let pendingSpace = false;
  let pendingSeparator = false;

  chars.forEach((char) => {
    if (/\s/.test(char)) {
      pendingSpace = true;
      return;
    }
    if (options.loose && !isWordChar(char)) {
      pendingSeparator = true;
      return;
    }

    if (parts.length > 0) {
      // A space in the term allows (but does not require) whitespace in the
      // text; elsewhere only zero-width/diacritic noise is allowed.
      if (pendingSeparator) parts.push(SEPARATOR_CLASS);
      else parts.push(pendingSpace ? `[\\s\\u200b-\\u200f]*` : IGNORABLE_CLASS);
    }
    pendingSpace = false;
    pendingSeparator = false;

    const variants = LETTER_VARIANTS[char] ?? DIGIT_VARIANTS[char];
    parts.push(
      variants ? `[${escapeForClass(variants)}]` : escapeLiteral(char),
    );
  });

  // In loose mode a space is also just a separator: the reviewer may have
  // joined or split words that the transcript writes the other way.
  if (options.loose) {
    return parts
      .map((part) =>
        part === `[\\s\\u200b-\\u200f]*` ? SEPARATOR_CLASS : part,
      )
      .join('');
  }

  return parts.join('');
}

/** A match may not be glued to another letter or digit on either side. */
const withBoundaries = (pattern: string) =>
  `(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`;

export interface FormMatcher<T> {
  regex: RegExp;
  /** Resolve a matched substring back to whatever the form belonged to. */
  resolve(matched: string): T | undefined;
}

/**
 * Build a single regex over many wordings, longest first — otherwise `روغن`
 * would win over `روغن پایه` and the longer term would never be found.
 *
 * `entries` maps a wording to the object it belongs to (a term, an anchor, …).
 */
export function buildFormMatcher<T>(
  entries: Array<{ form: string; value: T }>,
  options: { boundaries?: boolean } = {},
): FormMatcher<T> | null {
  const byCanonical = new Map<string, T>();
  const patterns: Array<{ pattern: string; length: number }> = [];

  entries.forEach(({ form, value }) => {
    const canonical = normalizeForCompare(form);
    if (canonical.length < 2) return; // single characters match everywhere
    if (!byCanonical.has(matchKey(form))) byCanonical.set(matchKey(form), value);

    const pattern = persianPatternFor(form);
    if (pattern) patterns.push({ pattern, length: canonical.length });
  });

  if (patterns.length === 0) return null;

  const source = patterns
    .sort((a, b) => b.length - a.length)
    .map((item) => item.pattern)
    .join('|');

  const boundaries = options.boundaries !== false;

  return {
    regex: new RegExp(
      boundaries ? withBoundaries(source) : `(?:${source})`,
      'gu',
    ),
    resolve: (matched: string) => byCanonical.get(matchKey(matched)),
  };
}

/** Compile one wording into a ready-to-use matcher (used for text anchors). */
export function buildSingleMatcher(
  form: string,
  options: { boundaries?: boolean; loose?: boolean } = {},
): RegExp | null {
  const pattern = persianPatternFor(form, { loose: options.loose });
  if (!pattern) return null;
  const boundaries = options.boundaries === true;
  return new RegExp(boundaries ? withBoundaries(pattern) : pattern, 'gu');
}
