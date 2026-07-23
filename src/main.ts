import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { configureFfmpeg } from './libs/ffmpeg/ffmpeg.util';

async function bootstrap() {
  // Point fluent-ffmpeg at the bundled ffmpeg/ffprobe binaries.
  configureFfmpeg();

  const app = await NestFactory.create(AppModule);

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
