import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { ChunkTargetMiddleware } from './chunk-target.middleware';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';

/**
 * Resumable chunked upload. Exported because creating a transcription consumes
 * a finished session instead of a multipart body.
 */
@Module({
  controllers: [UploadController],
  providers: [UploadService],
  exports: [UploadService],
})
export class UploadModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(ChunkTargetMiddleware)
      .forRoutes({ path: 'uploads/*path', method: RequestMethod.POST });
  }
}
