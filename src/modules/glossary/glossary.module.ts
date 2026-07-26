import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GlossaryMention, GlossaryTerm } from './glossary.entity';
import { GlossaryService } from './glossary.service';
import { GlossaryController } from './glossary.controller';
import { ProjectModule } from '../project/project.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([GlossaryTerm, GlossaryMention]),
    ProjectModule,
  ],
  controllers: [GlossaryController],
  providers: [GlossaryService],
  exports: [GlossaryService],
})
export class GlossaryModule {}
