import { HttpException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** Where sessions live. Siblings of the plain multipart uploads. */
const SESSION_ROOT = path.join(process.cwd(), 'temp', 'uploads', 'sessions');

/** Session ids are `randomUUID()`; anything else is not one of ours. */
const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const MANIFEST = 'manifest.json';
const CHUNK_DIR = 'chunks';

/** A two-hour meeting recorded as WAV is already ~1.2GB, so the cap is above that. */
const MAX_FILE_BYTES = 3 * 1024 * 1024 * 1024;

/** Bounds on the client's chunk size: small enough to retry, big enough to be fast. */
export const MIN_CHUNK_BYTES = 256 * 1024;
export const MAX_CHUNK_BYTES = 32 * 1024 * 1024;

/**
 * Abandoned sessions are deleted after this long. Long enough that a user who
 * closed the laptop overnight can still resume, short enough that a failed
 * 500MB upload does not sit on the disk for ever.
 */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const message = (error: unknown): string =>
  error instanceof Error ? error.message : 'unknown';

interface Manifest {
  id: string;
  filename: string;
  size: number;
  chunk_size: number;
  total_chunks: number;
  mimetype?: string | null;
  created_at: string;
  /** Set once the chunks have been joined; this is the file handed to create(). */
  assembled_path?: string | null;
}

export interface UploadSessionView {
  upload_id: string;
  filename: string;
  size: number;
  chunk_size: number;
  total_chunks: number;
  /** Indexes already on the server — the client uploads only what is missing. */
  received: number[];
  received_bytes: number;
  complete: boolean;
}

/**
 * Resumable uploads for meeting audio.
 *
 * A two-hour recording is hundreds of megabytes, and sending it as one request
 * does not survive contact with a real network: Node closes the socket at
 * `requestTimeout`, a phone switching to another cell tower kills it, and either
 * way the whole transfer starts from zero. On the uplink most users have, that is
 * a ten-minute loss — and it was happening repeatedly.
 *
 * So the file arrives in chunks, each its own short request, and the server keeps
 * what it already has. The state lives on disk rather than in a table: the chunk
 * directory *is* the record of progress, which means an API restart in the middle
 * of an upload costs nothing, and there is no migration and no row to leak.
 */
@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);

  constructor() {
    fs.mkdirSync(SESSION_ROOT, { recursive: true });
  }

  /**
   * Open a session. The client may keep the id and come back to it later — that
   * is what makes "resume" possible after a browser reload, where the `File`
   * object is gone but the bytes on the server are not.
   */
  init(input: {
    filename: string;
    size: number;
    chunk_size: number;
    mimetype?: string | null;
  }): UploadSessionView {
    const size = Number(input.size);
    if (!Number.isFinite(size) || size <= 0) {
      throw new HttpException('حجم فایل نامعتبر است', 400);
    }
    if (size > MAX_FILE_BYTES) {
      throw new HttpException(
        `حجم فایل بیش از حد مجاز است (سقف ${Math.floor(MAX_FILE_BYTES / (1024 * 1024 * 1024))} گیگابایت)`,
        413,
      );
    }

    const chunkSize = Number(input.chunk_size);
    if (
      !Number.isFinite(chunkSize) ||
      chunkSize < MIN_CHUNK_BYTES ||
      chunkSize > MAX_CHUNK_BYTES
    ) {
      throw new HttpException('اندازه تکه‌ها نامعتبر است', 400);
    }

    const filename = String(input.filename ?? '').trim();
    if (!filename) throw new HttpException('نام فایل لازم است', 400);

    // Opportunistic housekeeping: no scheduler in this service, and the moment
    // someone starts an upload is exactly when stale ones are worth removing.
    this.sweep();

    const manifest: Manifest = {
      id: randomUUID(),
      filename,
      size,
      chunk_size: chunkSize,
      total_chunks: Math.ceil(size / chunkSize),
      mimetype: input.mimetype ?? null,
      created_at: new Date().toISOString(),
      assembled_path: null,
    };

    fs.mkdirSync(path.join(SESSION_ROOT, manifest.id, CHUNK_DIR), {
      recursive: true,
    });
    this.writeManifest(manifest);

    this.logger.log(
      `[Upload] Session ${manifest.id} opened for "${filename}" ` +
        `(${(size / 1024 / 1024).toFixed(1)}MB in ${manifest.total_chunks} chunks)`,
    );

    return this.view(manifest);
  }

  /** What the server already has, so the client can skip it. */
  status(id: string): UploadSessionView {
    return this.view(this.readManifest(id));
  }

  /**
   * Where multer should put an incoming chunk.
   *
   * Written straight to its final name so nothing is buffered in memory and a
   * re-sent chunk simply overwrites the previous attempt — retrying a chunk has
   * to be safe, because retrying is the entire point.
   */
  chunkPath(id: string, index: number): string {
    const manifest = this.readManifest(id);
    if (!Number.isInteger(index) || index < 0) {
      throw new HttpException('شماره تکه نامعتبر است', 400);
    }
    if (index >= manifest.total_chunks) {
      throw new HttpException('شماره تکه بیش از تعداد تکه‌های فایل است', 400);
    }
    if (manifest.assembled_path) {
      throw new HttpException('این آپلود قبلاً کامل شده است', 409);
    }
    return path.join(SESSION_ROOT, id, CHUNK_DIR, String(index));
  }

  /** Progress after a chunk landed. */
  chunkReceived(id: string): UploadSessionView {
    return this.view(this.readManifest(id));
  }

  /**
   * Join the chunks into one file.
   *
   * The assembled size is checked against what the client declared at `init`:
   * a truncated chunk is otherwise indistinguishable from a complete upload
   * until ffmpeg fails hours later with something unhelpful.
   */
  complete(id: string): { upload_id: string; filename: string; size: number } {
    const manifest = this.readManifest(id);

    if (manifest.assembled_path && fs.existsSync(manifest.assembled_path)) {
      return {
        upload_id: id,
        filename: manifest.filename,
        size: fs.statSync(manifest.assembled_path).size,
      };
    }

    const received = this.receivedChunks(manifest);
    if (received.length !== manifest.total_chunks) {
      const missing = manifest.total_chunks - received.length;
      throw new HttpException(
        `آپلود کامل نیست؛ ${missing} تکه نرسیده است`,
        409,
      );
    }

    const target = path.join(
      SESSION_ROOT,
      id,
      `assembled${path.extname(manifest.filename) || '.bin'}`,
    );

    const out = fs.openSync(target, 'w');
    try {
      for (let index = 0; index < manifest.total_chunks; index += 1) {
        const chunk = fs.readFileSync(
          path.join(SESSION_ROOT, id, CHUNK_DIR, String(index)),
        );
        fs.writeSync(out, chunk);
      }
    } catch (error) {
      fs.closeSync(out);
      this.remove(target);
      throw error;
    }
    fs.closeSync(out);

    const assembledSize = fs.statSync(target).size;
    if (assembledSize !== manifest.size) {
      this.remove(target);
      throw new HttpException(
        `حجم فایل بازسازی‌شده با حجم اعلام‌شده نمی‌خواند (${assembledSize} از ${manifest.size})؛ آپلود را دوباره انجام دهید`,
        409,
      );
    }

    manifest.assembled_path = target;
    this.writeManifest(manifest);
    fs.rmSync(path.join(SESSION_ROOT, id, CHUNK_DIR), {
      recursive: true,
      force: true,
    });

    this.logger.log(
      `[Upload] Session ${id} assembled: "${manifest.filename}" ` +
        `(${(assembledSize / 1024 / 1024).toFixed(1)}MB)`,
    );

    return { upload_id: id, filename: manifest.filename, size: assembledSize };
  }

  /**
   * Hand the assembled file to whoever consumes it (creating a transcription),
   * in the shape multer would have produced. The session directory goes away:
   * from here on the file's life belongs to the pipeline.
   */
  take(id: string): { path: string; originalname: string } {
    const manifest = this.readManifest(id);
    if (!manifest.assembled_path || !fs.existsSync(manifest.assembled_path)) {
      throw new HttpException(
        'این آپلود کامل نشده است؛ ابتدا آن را کامل کنید',
        409,
      );
    }

    // Moved out of the session directory before that directory is deleted.
    const handoff = path.join(
      process.cwd(),
      'temp',
      'uploads',
      `resumable-${id}${path.extname(manifest.filename) || '.bin'}`,
    );
    fs.renameSync(manifest.assembled_path, handoff);
    this.discard(id);

    return { path: handoff, originalname: manifest.filename };
  }

  /** Give up on a session and free the disk. */
  discard(id: string): { success: boolean } {
    if (!SESSION_ID.test(id)) {
      throw new HttpException('شناسه آپلود نامعتبر است', 400);
    }
    fs.rmSync(path.join(SESSION_ROOT, id), { recursive: true, force: true });
    return { success: true };
  }

  // ---------------------------------------------------------------------------

  private view(manifest: Manifest): UploadSessionView {
    const received = manifest.assembled_path
      ? Array.from({ length: manifest.total_chunks }, (_, index) => index)
      : this.receivedChunks(manifest);

    return {
      upload_id: manifest.id,
      filename: manifest.filename,
      size: manifest.size,
      chunk_size: manifest.chunk_size,
      total_chunks: manifest.total_chunks,
      received,
      received_bytes: manifest.assembled_path
        ? manifest.size
        : this.receivedBytes(manifest, received),
      complete: !!manifest.assembled_path,
    };
  }

  /**
   * Indexes present on disk, **at their full expected length**.
   *
   * A short chunk is a chunk whose request was cut off, and counting it as
   * received is how a corrupt file gets assembled: the byte count would look
   * right in the UI and the audio would be silently truncated.
   */
  private receivedChunks(manifest: Manifest): number[] {
    const dir = path.join(SESSION_ROOT, manifest.id, CHUNK_DIR);
    if (!fs.existsSync(dir)) return [];

    const received: number[] = [];
    fs.readdirSync(dir).forEach((name) => {
      const index = Number(name);
      if (!Number.isInteger(index) || index < 0) return;
      if (index >= manifest.total_chunks) return;

      const expected = this.expectedChunkSize(manifest, index);
      let actual = 0;
      try {
        actual = fs.statSync(path.join(dir, name)).size;
      } catch {
        return;
      }
      if (actual === expected) received.push(index);
    });

    return received.sort((a, b) => a - b);
  }

  /** The last chunk is short by design; every other one is exactly chunk_size. */
  private expectedChunkSize(manifest: Manifest, index: number): number {
    const isLast = index === manifest.total_chunks - 1;
    return isLast
      ? manifest.size - manifest.chunk_size * index
      : manifest.chunk_size;
  }

  private receivedBytes(manifest: Manifest, received: number[]): number {
    return received.reduce(
      (total, index) => total + this.expectedChunkSize(manifest, index),
      0,
    );
  }

  private readManifest(id: string): Manifest {
    if (!SESSION_ID.test(id)) {
      throw new HttpException('شناسه آپلود نامعتبر است', 400);
    }
    const file = path.join(SESSION_ROOT, id, MANIFEST);
    if (!fs.existsSync(file)) {
      // Also what an expired session looks like, which is worth saying out loud:
      // the client should start over rather than retry for ever.
      throw new HttpException('این آپلود پیدا نشد یا منقضی شده است', 404);
    }
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
  }

  private writeManifest(manifest: Manifest): void {
    fs.writeFileSync(
      path.join(SESSION_ROOT, manifest.id, MANIFEST),
      JSON.stringify(manifest, null, 1),
      'utf8',
    );
  }

  private remove(file: string): void {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* ignore */
    }
  }

  /**
   * Delete what nobody came back for: abandoned sessions, and the loose files in
   * `temp/uploads` left behind when a process died mid-pipeline.
   *
   * Both are pure waste — an interrupted 500MB upload otherwise sits on the disk
   * for ever, and one such orphan was found during this work. Anything younger
   * than the TTL is left alone, so an upload in flight is never touched.
   *
   * Never throws: this is housekeeping, and it must not fail the request that
   * happened to trigger it.
   */
  private sweep(): void {
    const cutoff = Date.now() - SESSION_TTL_MS;

    try {
      fs.readdirSync(SESSION_ROOT).forEach((id) => {
        if (!SESSION_ID.test(id)) return;
        const dir = path.join(SESSION_ROOT, id);
        if (fs.statSync(dir).mtimeMs < cutoff) {
          fs.rmSync(dir, { recursive: true, force: true });
          this.logger.log(`[Upload] Swept abandoned session ${id}`);
        }
      });
    } catch (error) {
      this.logger.warn(`[Upload] Session sweep failed: ${message(error)}`);
    }

    try {
      const uploadRoot = path.join(process.cwd(), 'temp', 'uploads');
      fs.readdirSync(uploadRoot, { withFileTypes: true }).forEach((entry) => {
        if (!entry.isFile()) return;
        const file = path.join(uploadRoot, entry.name);
        if (fs.statSync(file).mtimeMs < cutoff) {
          fs.rmSync(file, { force: true });
          this.logger.log(`[Upload] Swept orphaned temp file ${entry.name}`);
        }
      });
    } catch (error) {
      this.logger.warn(`[Upload] Temp sweep failed: ${message(error)}`);
    }
  }
}
