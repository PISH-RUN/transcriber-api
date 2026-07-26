import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EvidenceItem } from './evidence.entity';
import { EvidenceService } from './evidence.service';
import { EvidenceController } from './evidence.controller';
import { ProjectModule } from '../project/project.module';
import { Transcription } from '../transcription/transcription.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([EvidenceItem, Transcription]),
    ProjectModule,
  ],
  controllers: [EvidenceController],
  providers: [EvidenceService],
  exports: [EvidenceService],
})
export class EvidenceModule {}
