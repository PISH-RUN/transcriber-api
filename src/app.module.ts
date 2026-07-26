import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DataSource } from 'typeorm';
import { AuthModule } from './modules/auth/auth.module';
import { DatabaseModule } from './libs/database/database.module';
import { LoggerMiddleware } from './libs/logger/logger.middleware';
import { ConfigModule } from './libs/config/config.module';
import { UserModule } from './modules/user/user.module';
import { FileModule } from './modules/file/file.module';
import { PersonModule } from './modules/person/person.module';
import { ProjectModule } from './modules/project/project.module';
import { AnalysisModule } from './modules/analysis/analysis.module';
import { GlossaryModule } from './modules/glossary/glossary.module';
import { EvidenceModule } from './modules/evidence/evidence.module';
import { TranscriptionModule } from './modules/transcription/transcription.module';
import { AiExtractionModule } from './modules/ai-extraction/ai-extraction.module';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ResponseInterceptor } from './libs/interceptors/response.interceptor';

@Module({
  imports: [
    AuthModule,
    DatabaseModule,
    ConfigModule,
    UserModule,
    FileModule,
    PersonModule,
    ProjectModule,
    GlossaryModule,
    EvidenceModule,
    AnalysisModule,
    TranscriptionModule,
    AiExtractionModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_INTERCEPTOR,
      useClass: ResponseInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  constructor(private dataSource: DataSource) {}

  configure(consumer: MiddlewareConsumer) {
    consumer.apply(LoggerMiddleware).forRoutes('*');
  }
}
