import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TranscriptAnalysis } from './analysis.entity';
import { AnalysisService } from './analysis.service';
import { AnalysisController } from './analysis.controller';
import { ProjectModule } from '../project/project.module';
import { Transcription } from '../transcription/transcription.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([TranscriptAnalysis, Transcription]),
    ProjectModule,
  ],
  controllers: [AnalysisController],
  providers: [AnalysisService],
  exports: [AnalysisService],
})
export class AnalysisModule {}
