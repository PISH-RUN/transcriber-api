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
import { GlossaryModule } from '../glossary/glossary.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Transcription, TranscriptionAudio]),
    FileModule,
    AudioModule,
    PersonModule,
    ProjectModule,
    AnalysisModule,
    AiModule,
    // For the automatic glossary scan after processing. GlossaryModule pulls in
    // the Transcription entity, not this module, so there is no cycle.
    GlossaryModule,
  ],
  controllers: [TranscriptionController],
  providers: [TranscriptionService],
  exports: [TranscriptionService],
})
export class TranscriptionModule {}
