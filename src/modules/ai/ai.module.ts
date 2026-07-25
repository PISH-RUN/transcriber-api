import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GeminiService } from './gemini.service';
import { TranscriptRefineService } from './transcript-refine.service';

/**
 * LLM building blocks. Like AudioModule, this must not depend on any domain
 * module so it can be imported freely.
 */
@Module({
  imports: [ConfigModule],
  providers: [GeminiService, TranscriptRefineService],
  exports: [GeminiService, TranscriptRefineService],
})
export class AiModule {}
