import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SonioxClientService } from './soniox-client.service';
import { PyannoteService } from './pyannote.service';
import { TranscriptMergerService } from './transcript-merger.service';
import { AudioProcessorService } from './audio-processor.service';

/**
 * Dependency-free audio pipeline building blocks: external STT/diarization
 * clients plus ffmpeg helpers. Both PersonModule and TranscriptionModule
 * import this, so it must not depend on either of them.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    SonioxClientService,
    PyannoteService,
    TranscriptMergerService,
    AudioProcessorService,
  ],
  exports: [
    SonioxClientService,
    PyannoteService,
    TranscriptMergerService,
    AudioProcessorService,
  ],
})
export class AudioModule {}
