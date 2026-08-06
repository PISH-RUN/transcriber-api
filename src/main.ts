import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { configureFfmpeg } from './libs/ffmpeg/ffmpeg.util';

// Max JSON body size. Editing a long transcript sends the whole `segments`
// array back, which comfortably exceeds Express's ~100kb default and would
// otherwise fail with HTTP 413 "request entity too large".
const JSON_BODY_LIMIT = '25mb';

/**
 * How long a single request may take.
 *
 * Node's default is 5 minutes, and it closes the socket the moment it is hit —
 * which the browser reports as a bare "network error", indistinguishable from a
 * lost connection. Uploading a two-hour recording on a normal uplink takes longer
 * than that, so large uploads were failing at the five-minute mark, repeatedly.
 *
 * Audio now arrives in chunks (see UploadModule), each of which finishes in
 * seconds, so this ceiling is only a safety net — for the single-request upload
 * path that still exists, and for a slow S3 hand-off inside a request.
 */
const REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Keep-alive has to outlive the gap between chunk requests, and `headersTimeout`
 * must stay above `keepAliveTimeout` or Node races itself and drops sockets that
 * were about to be reused.
 */
const KEEP_ALIVE_TIMEOUT_MS = 75 * 1000;
const HEADERS_TIMEOUT_MS = 80 * 1000;

async function bootstrap() {
  // Point fluent-ffmpeg at the bundled ffmpeg/ffprobe binaries.
  configureFfmpeg();

  // Disable the built-in body parser so we can register our own with a larger
  // limit. (Audio uploads use multipart/multer per-route and are unaffected.)
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  app.use(json({ limit: JSON_BODY_LIMIT }));
  app.use(urlencoded({ extended: true, limit: JSON_BODY_LIMIT }));

  // The transcriber MVP has no auth; allow the frontend (and any local tool)
  // to call the API directly from the browser.
  app.enableCors({
    origin: true,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true, // Transform DTO to plain object
      // whitelist: true, // Strip out properties that are not in the DTO
    }),
  );

  await app.listen(process.env.PORT ?? 3000, process.env.HOST ?? 'localhost');

  const server = app.getHttpServer();
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
}

bootstrap()
  .then(() => {
    console.log(
      `Server is running on http://${process.env.HOST ?? 'localhost'}:${process.env.PORT ?? 3000}`,
    );
  })
  .catch((err) => {
    console.log('error in running server', err);
  });
