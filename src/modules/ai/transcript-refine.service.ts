import { Injectable, Logger } from '@nestjs/common';
import { GeminiService } from './gemini.service';

// ---------------------------------------------------------------------------
// Batching limits. Small enough that a batch always fits comfortably inside the
// output budget (so nothing gets truncated), large enough that the model still
// sees several turns of context at once.
const MAX_BATCH_CHARS = 4500;
const MAX_BATCH_LINES = 35;

/** Lines of original text handed to the model purely as preceding context. */
const CONTEXT_LINES = 4;

/** Batches processed in parallel. Keeps wall-clock time sane without hammering rate limits. */
const CONCURRENCY = 3;

/**
 * A corrected line is rejected when it lost this much of its content — the task
 * is proof-reading, so a line that suddenly shrank means the model summarized
 * or dropped something despite the instructions.
 */
const MIN_LENGTH_RATIO = 0.5;

// ---------------------------------------------------------------------------

/**
 * The reviewer's brief, kept verbatim: this prompt is the product decision, so
 * it lives in one place and is not assembled from fragments elsewhere.
 */
const SYSTEM_PROMPT = `این فایل، خروجی STT یک جلسه چندنفره تدبر در قرآن است.
فقط خطاهای پیاده‌سازی گفتار را اصلاح کن و به محتوای جلسه دست نزن.

قواعد اصلاح:
1. لحن محاوره‌ای گویندگان حفظ شود.
2. تکرارها، مکث‌ها، شوخی‌ها، جمله‌های نیمه‌تمام و قطع‌کردن صحبت یکدیگر حذف نشوند.
3. جمله‌ها ادبی‌سازی، خلاصه‌سازی یا بازنویسی نشوند.
4. فقط واژه‌ها و عبارت‌هایی اصلاح شوند که با توجه به سیاق، خطای STT بودنشان روشن است.
5. آیات، عبارات عربی، اصطلاحات قرآنی و نام‌های خاص با دقت اصلاح شوند.
6. وقتی اصلاح یک عبارت قطعی نیست، حدس قطعی نزن و آن را با [نامفهوم] یا [احتمالاً: ...] مشخص کن.
7. پاراگراف‌بندی و نشانه‌گذاری فقط برای خوانایی انجام شود و ترتیب صحبت‌ها تغییر نکند.
8. متن خروجی کامل باشد و هیچ بخشی حذف یا خلاصه نشود.

قواعد فنی خروجی:
- متن به‌صورت خط‌های شماره‌دار به تو داده می‌شود. هر خط یک نوبت صحبت است.
- برای هر خط ورودی، دقیقاً یک خط خروجی با همان شماره برگردان. هیچ خطی را حذف، ادغام یا جابه‌جا نکن.
- مرز خط‌ها را تغییر نده؛ متنی را از یک خط به خط دیگر منتقل نکن.
- اگر خطی هیچ خطای آشکاری ندارد، عیناً همان متن را برگردان.
- خروجی فقط یک شیء JSON معتبر باشد، بدون توضیح و بدون بلوک کد:
{"lines":[{"i":<شماره خط>,"text":"<متن اصلاح‌شده>"}]}`;

// ---------------------------------------------------------------------------

export interface RefinableSegment {
  speaker_label?: string;
  text?: string;
}

export interface RefineResult {
  /** Corrected text per input segment, same length and order as the input. */
  texts: string[];
  changed: number;
  /** Lines the model returned but we rejected (too short / empty). */
  rejected: number;
  /** Batches that failed outright; their lines were left untouched. */
  failedBatches: number;
  totalBatches: number;
}

interface Batch {
  /** Indexes into the original segment array. */
  indexes: number[];
  contextFrom: number;
}

@Injectable()
export class TranscriptRefineService {
  private readonly logger = new Logger(TranscriptRefineService.name);

  constructor(private readonly gemini: GeminiService) {}

  isConfigured(): boolean {
    return this.gemini.isConfigured();
  }

  get model(): string {
    return this.gemini.model;
  }

  /**
   * Proof-read a transcript one batch of turns at a time.
   *
   * Working per segment (instead of over one giant blob of text) is what keeps
   * the result usable: speaker attribution, timestamps and the audio timeline
   * all stay aligned, because we only ever replace the text of a line — never
   * its boundaries, order or count.
   */
  async refineSegments(
    segments: RefinableSegment[],
    onProgress?: (done: number, total: number) => void | Promise<void>,
  ): Promise<RefineResult> {
    const texts = segments.map((segment) => segment.text ?? '');
    const batches = this.buildBatches(segments);

    const result: RefineResult = {
      texts,
      changed: 0,
      rejected: 0,
      failedBatches: 0,
      totalBatches: batches.length,
    };

    if (!batches.length) return result;

    let done = 0;
    let cursor = 0;

    const worker = async () => {
      for (;;) {
        const current = cursor;
        cursor += 1;
        if (current >= batches.length) return;

        const batch = batches[current];
        try {
          const corrections = await this.refineBatch(segments, batch);

          batch.indexes.forEach((index) => {
            const corrected = corrections.get(index);
            if (corrected == null) return;

            const original = texts[index];
            const cleaned = corrected.trim();

            if (!cleaned) {
              result.rejected += 1;
              return;
            }
            if (cleaned === original.trim()) return;
            if (!this.keepsContent(original, cleaned)) {
              this.logger.warn(
                `Rejected refinement of line ${index}: ${original.length} -> ${cleaned.length} chars`,
              );
              result.rejected += 1;
              return;
            }

            texts[index] = cleaned;
            result.changed += 1;
          });
        } catch (error: any) {
          // A failed batch keeps its original text — a partial improvement is
          // far better than losing the whole run.
          result.failedBatches += 1;
          this.logger.error(
            `Refine batch ${current + 1}/${batches.length} failed: ${error?.message}`,
          );
        }

        done += 1;
        if (onProgress) await onProgress(done, batches.length);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () =>
        worker(),
      ),
    );

    return result;
  }

  // -------------------------------------------------------------------------

  private buildBatches(segments: RefinableSegment[]): Batch[] {
    const batches: Batch[] = [];
    let indexes: number[] = [];
    let chars = 0;

    const flush = () => {
      if (!indexes.length) return;
      batches.push({
        indexes,
        contextFrom: Math.max(0, indexes[0] - CONTEXT_LINES),
      });
      indexes = [];
      chars = 0;
    };

    segments.forEach((segment, index) => {
      const text = (segment.text ?? '').trim();
      if (!text) return; // nothing to proof-read

      if (
        indexes.length > 0 &&
        (chars + text.length > MAX_BATCH_CHARS ||
          indexes.length >= MAX_BATCH_LINES)
      ) {
        flush();
      }

      indexes.push(index);
      chars += text.length;
    });

    flush();
    return batches;
  }

  private async refineBatch(
    segments: RefinableSegment[],
    batch: Batch,
  ): Promise<Map<number, string>> {
    const first = batch.indexes[0];

    const context = segments
      .slice(batch.contextFrom, first)
      .map(
        (segment) =>
          `${segment.speaker_label ?? '؟'}: ${(segment.text ?? '').trim()}`,
      )
      .filter((line) => line.length > 2);

    const lines = batch.indexes.map((index) => ({
      i: index,
      speaker: segments[index].speaker_label ?? '؟',
      text: (segments[index].text ?? '').trim(),
    }));

    const parts: string[] = [];
    if (context.length) {
      parts.push(
        '### بافت پیشین (فقط برای فهم سیاق؛ این خط‌ها را در خروجی برنگردان)',
        context.join('\n'),
        '',
      );
    }
    parts.push(
      '### خط‌هایی که باید اصلاح شوند',
      JSON.stringify({ lines }, null, 0),
      '',
      `خروجی: یک شیء JSON با کلید "lines" شامل دقیقاً ${lines.length} عضو، با همان شماره‌های i.`,
    );

    const raw = await this.gemini.complete({
      system: SYSTEM_PROMPT,
      user: parts.join('\n'),
      temperature: 0.15,
      maxOutputTokens: 8192,
      timeoutMs: 180000,
      json: true,
    });

    return this.parseCorrections(raw, batch.indexes);
  }

  /**
   * Tolerant JSON extraction: models occasionally wrap the object in a code
   * fence or add a sentence around it, and one malformed batch shouldn't take
   * the run down.
   */
  private parseCorrections(
    raw: string,
    allowed: number[],
  ): Map<number, string> {
    const allowedSet = new Set(allowed);
    const cleaned = raw
      .replace(/^\s*```(?:json)?/i, '')
      .replace(/```\s*$/, '')
      .trim();

    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end <= start) {
      throw new Error('پاسخ مدل JSON معتبر نبود');
    }

    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    const lines = Array.isArray(parsed?.lines) ? parsed.lines : null;
    if (!lines) throw new Error('پاسخ مدل کلید lines نداشت');

    const corrections = new Map<number, string>();
    lines.forEach((line: any) => {
      const index = Number(line?.i);
      if (!Number.isInteger(index) || !allowedSet.has(index)) return;
      if (typeof line?.text !== 'string') return;
      corrections.set(index, line.text);
    });

    return corrections;
  }

  /** Guards rule 8: a proof-read line must not lose its content. */
  private keepsContent(original: string, corrected: string): boolean {
    const weight = (value: string) => value.replace(/\s+/g, '').length;
    const originalWeight = weight(original);
    if (originalWeight < 40) return true; // short lines: ratio is meaningless
    return weight(corrected) >= originalWeight * MIN_LENGTH_RATIO;
  }
}
