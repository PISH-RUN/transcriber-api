import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GlossaryMention, GlossaryTerm } from './glossary.entity';
import { GlossaryService } from './glossary.service';
import { GlossaryScanService } from './glossary-scan.service';
import { GlossaryImportService } from './glossary-import.service';
import { GlossaryController } from './glossary.controller';
import { ProjectModule } from '../project/project.module';
import { PersonModule } from '../person/person.module';
import { Transcription } from '../transcription/transcription.entity';

@Module({
  imports: [
    // Transcription is read-only here: the scan needs the `segments` column to
    // find terms in the text.
    TypeOrmModule.forFeature([GlossaryTerm, GlossaryMention, Transcription]),
    ProjectModule,
    // The scan resolves speaker ids to the mapped person's name.
    PersonModule,
  ],
  controllers: [GlossaryController],
  providers: [GlossaryService, GlossaryScanService, GlossaryImportService],
  exports: [GlossaryService, GlossaryScanService],
})
export class GlossaryModule {}
