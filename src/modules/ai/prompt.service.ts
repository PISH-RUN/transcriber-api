import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

/** Prompt files that ship with the API, by logical name. */
export const PROMPTS = {
  glossaryExtraction: 'glossary-extraction.md',
  evidenceExtraction: 'evidence-extraction.md',
} as const;

export type PromptName = keyof typeof PROMPTS;

/**
 * Reads system prompts from `src/prompts/*.md` at request time.
 *
 * These prompts are the product, not implementation detail: they get tuned far
 * more often than the code around them. Keeping them as Markdown files means a
 * change is a text edit — no recompiling, no hunting for a template literal, and
 * the file stays readable and reviewable on its own.
 *
 * Files are cached after first read, with the modification time as the cache
 * key, so an edit is picked up without a restart while a hot loop still doesn't
 * hit the disk every time.
 */
@Injectable()
export class PromptService {
  private readonly logger = new Logger(PromptService.name);
  private readonly cache = new Map<string, { mtimeMs: number; text: string }>();

  /** Directories to look in, in order of preference. */
  private readonly roots = [
    // Compiled output (nest-cli copies prompts/*.md into dist).
    path.join(__dirname, '..', '..', 'prompts'),
    // Running from source (ts-node / start:dev before assets are copied).
    path.join(process.cwd(), 'src', 'prompts'),
    path.join(process.cwd(), 'dist', 'prompts'),
  ];

  get(name: PromptName): string {
    const file = PROMPTS[name];
    const resolved = this.resolve(file);

    if (!resolved) {
      throw new Error(
        `فایل پرامپت «${file}» پیدا نشد (مسیرهای بررسی‌شده: ${this.roots.join(', ')})`,
      );
    }

    const stat = fs.statSync(resolved);
    const cached = this.cache.get(resolved);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.text;

    const text = fs.readFileSync(resolved, 'utf8').trim();
    if (!text) throw new Error(`فایل پرامپت «${file}» خالی است`);

    this.cache.set(resolved, { mtimeMs: stat.mtimeMs, text });
    this.logger.log(
      `Loaded prompt ${file} (${text.length} chars) from ${resolved}`,
    );
    return text;
  }

  private resolve(file: string): string | null {
    for (const root of this.roots) {
      const candidate = path.join(root, file);
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }
}
