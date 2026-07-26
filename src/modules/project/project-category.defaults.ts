import { ProjectCategoryKind } from './project-category.entity';

export interface DefaultCategory {
  key: string;
  label: string;
  color: string;
}

/**
 * The starting taxonomy every new project is seeded with. Projects are free to
 * change it afterwards, so these values are a starting point — never a
 * constraint.
 */
export const DEFAULT_GLOSSARY_CATEGORIES: DefaultCategory[] = [
  { key: 'person', label: 'افراد', color: '#1877F2' },
  { key: 'company', label: 'شرکت‌ها', color: '#00A76F' },
  { key: 'brand', label: 'برندها', color: '#8E33FF' },
  { key: 'unit', label: 'واحدها', color: '#006C9C' },
  { key: 'product', label: 'محصولات', color: '#B76E00' },
  { key: 'system', label: 'سامانه‌ها', color: '#5119B7' },
  { key: 'project', label: 'پروژه‌ها', color: '#0C68E9' },
  { key: 'market', label: 'کشورها و بازارها', color: '#118D57' },
  { key: 'process', label: 'فرایندها', color: '#B71D18' },
  { key: 'term', label: 'شاخص‌ها و اصطلاحات تخصصی', color: '#7A0916' },
  { key: 'other', label: 'سایر', color: '#637381' },
];

export const DEFAULT_EVIDENCE_TYPES: DefaultCategory[] = [
  { key: 'claimed_fact', label: 'واقعیت ادعاشده', color: '#1877F2' },
  { key: 'quantitative', label: 'عدد یا داده کمی', color: '#00A76F' },
  { key: 'estimate', label: 'تخمین', color: '#118D57' },
  { key: 'opinion', label: 'نظر شخصی', color: '#8E33FF' },
  { key: 'historical', label: 'خاطره تاریخی', color: '#5119B7' },
  { key: 'judgment', label: 'قضاوت درباره فرد یا واحد', color: '#B71D18' },
  { key: 'causal', label: 'رابطه علت و معلولی', color: '#006C9C' },
  { key: 'decision', label: 'تصمیم', color: '#0C68E9' },
  { key: 'action_taken', label: 'اقدام انجام‌شده', color: '#007867' },
  { key: 'future_plan', label: 'برنامه آینده', color: '#B76E00' },
  { key: 'problem', label: 'مشکل', color: '#7A0916' },
  { key: 'need', label: 'نیاز', color: '#FF5630' },
  { key: 'suggestion', label: 'پیشنهاد', color: '#FFAB00' },
  { key: 'expectation', label: 'انتظار', color: '#C684FF' },
  { key: 'example', label: 'مثال یا واقعه', color: '#61F3F3' },
  { key: 'reference', label: 'ارجاع به سند یا فرد دیگر', color: '#637381' },
];

/**
 * The angles a recording is usually analysed from. These are the documents a
 * reviewer brings back from other tools, one per aspect of the same voice.
 */
export const DEFAULT_ANALYSIS_KINDS: DefaultCategory[] = [
  { key: 'profile', label: 'شناسنامه ویس', color: '#1877F2' },
  { key: 'evidence_extraction', label: 'استخراج کامل شواهد', color: '#00A76F' },
  { key: 'structuring', label: 'تنظیم و ساختاربندی اطلاعات', color: '#8E33FF' },
  {
    key: 'cross_validation',
    label: 'مقایسه و اعتبارسنجی میان منابع',
    color: '#B76E00',
  },
  { key: 'summary', label: 'خلاصه و نکات کلیدی', color: '#118D57' },
  { key: 'other', label: 'سایر', color: '#637381' },
];

const DEFAULTS: Record<ProjectCategoryKind, DefaultCategory[]> = {
  [ProjectCategoryKind.GLOSSARY]: DEFAULT_GLOSSARY_CATEGORIES,
  [ProjectCategoryKind.EVIDENCE]: DEFAULT_EVIDENCE_TYPES,
  [ProjectCategoryKind.ANALYSIS]: DEFAULT_ANALYSIS_KINDS,
};

export const defaultsFor = (kind: ProjectCategoryKind): DefaultCategory[] =>
  DEFAULTS[kind] ?? [];

/** Which table/column a taxonomy is referenced from, for usage counting. */
const USAGE_SOURCES: Record<
  ProjectCategoryKind,
  { table: string; column: string }
> = {
  [ProjectCategoryKind.GLOSSARY]: {
    table: 'glossary_terms',
    column: 'category',
  },
  [ProjectCategoryKind.EVIDENCE]: { table: 'evidence_items', column: 'type' },
  [ProjectCategoryKind.ANALYSIS]: {
    table: 'transcript_analyses',
    column: 'kind',
  },
};

export const usageSourceFor = (kind: ProjectCategoryKind) =>
  USAGE_SOURCES[kind];
