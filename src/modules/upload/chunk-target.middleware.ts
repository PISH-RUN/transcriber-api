import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { UploadService } from './upload.service';

/** `/uploads/<session>/chunks/<index>`, with or without a trailing slash. */
const CHUNK_ROUTE = /\/uploads\/([^/]+)\/chunks\/(\d+)\/?$/;

/**
 * Resolve where an incoming chunk belongs *before* multer starts writing.
 *
 * multer needs the destination and filename synchronously, but deciding them
 * means validating the session and the chunk index first — and an interceptor
 * runs too late for that. Middleware runs before the body is touched, so an
 * unknown session or an out-of-range index is rejected without a single byte
 * being written to disk.
 */
@Injectable()
export class ChunkTargetMiddleware implements NestMiddleware {
  constructor(private readonly uploadService: UploadService) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    // Parsed from the path rather than `req.params`: Nest mounts middleware with
    // `app.use(path, …)`, which does not populate route parameters.
    const match = CHUNK_ROUTE.exec(req.path);
    if (!match) {
      next();
      return;
    }

    try {
      (req as unknown as { chunkTarget?: string }).chunkTarget =
        this.uploadService.chunkPath(match[1], Number(match[2]));
      next();
    } catch (error) {
      next(error);
    }
  }
}
