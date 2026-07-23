import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Transcription, TranscriptionAudio } from './transcription.entity';
import { TranscriptionService } from './transcription.service';
import { TranscriptionController } from './transcription.controller';
import { FileModule } from '../file/file.module';
import { AudioModule } from '../audio/audio.module';
import { PersonModule } from '../person/person.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Transcription, TranscriptionAudio]),
    FileModule,
    AudioModule,
    PersonModule,
  ],
  controllers: [TranscriptionController],
  providers: [TranscriptionService],
  exports: [TranscriptionService],
})
export class TranscriptionModule {}
