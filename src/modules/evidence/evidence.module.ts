import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EvidenceItem, EvidenceTermLink } from './evidence.entity';
import { EvidenceService } from './evidence.service';
import { EvidenceImportService } from './evidence-import.service';
import { EvidenceController } from './evidence.controller';
import { ProjectModule } from '../project/project.module';
import { GlossaryTerm } from '../glossary/glossary.entity';
import { Transcription } from '../transcription/transcription.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      EvidenceItem,
      EvidenceTermLink,
      GlossaryTerm,
      Transcription,
    ]),
    ProjectModule,
  ],
  controllers: [EvidenceController],
  providers: [EvidenceService, EvidenceImportService],
  exports: [EvidenceService],
})
export class EvidenceModule {}
