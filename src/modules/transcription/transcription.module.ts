import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Transcription, TranscriptionAudio } from './transcription.entity';
import { TranscriptionService } from './transcription.service';
import { TranscriptionController } from './transcription.controller';
import { AiModule } from '../ai/ai.module';
import { FileModule } from '../file/file.module';
import { AudioModule } from '../audio/audio.module';
import { PersonModule } from '../person/person.module';
import { ProjectModule } from '../project/project.module';
import { AnalysisModule } from '../analysis/analysis.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Transcription, TranscriptionAudio]),
    FileModule,
    AudioModule,
    PersonModule,
    ProjectModule,
    AnalysisModule,
    AiModule,
  ],
  controllers: [TranscriptionController],
  providers: [TranscriptionService],
  exports: [TranscriptionService],
})
export class TranscriptionModule {}
