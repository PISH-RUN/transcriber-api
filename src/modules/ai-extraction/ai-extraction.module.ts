import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiCandidateRejection, AiExtractionRun } from './ai-extraction.entity';
import { AiExtractionService } from './ai-extraction.service';
import { AiExtractionController } from './ai-extraction.controller';
import { GlossaryExtractionService } from './glossary-extraction.service';
import { EvidenceExtractionService } from './evidence-extraction.service';
import { AiModule } from '../ai/ai.module';
import { ProjectModule } from '../project/project.module';
import { GlossaryModule } from '../glossary/glossary.module';
import { EvidenceModule } from '../evidence/evidence.module';
import { Project } from '../project/project.entity';
import { GlossaryTerm } from '../glossary/glossary.entity';
import { EvidenceItem } from '../evidence/evidence.entity';
import { Transcription } from '../transcription/transcription.entity';

/**
 * The AI extraction layer: it reads transcripts and writes proposals, and it
 * depends on the glossary and evidence modules rather than the other way round.
 * Neither of those knows this module exists, so there is no cycle and both keep
 * working with the AI service switched off.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      AiExtractionRun,
      AiCandidateRejection,
      Transcription,
      GlossaryTerm,
      EvidenceItem,
      Project,
    ]),
    AiModule,
    ProjectModule,
    GlossaryModule,
    EvidenceModule,
  ],
  controllers: [AiExtractionController],
  providers: [
    AiExtractionService,
    GlossaryExtractionService,
    EvidenceExtractionService,
  ],
  exports: [AiExtractionService],
})
export class AiExtractionModule {}
