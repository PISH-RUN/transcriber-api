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
