import { Column, Entity } from 'typeorm';
import { BaseTimestampEntity } from '../../common/abstracts/base.entity';

/**
 * A known person in the voice-print library. When a person has a stored
 * `voiceprint` (created via pyannoteAI /voiceprint), the identification step
 * can automatically match them to a detected speaker in future transcriptions.
 */
@Entity('persons')
export class Person extends BaseTimestampEntity {
  @Column({ length: 255 })
  name: string;

  // Optional avatar/label color for the UI.
  @Column({ length: 32, nullable: true })
  color?: string;

  // Opaque voiceprint blob returned by pyannoteAI. Excluded from default
  // selects because it can be large.
  @Column({ type: 'text', nullable: true, select: false })
  voiceprint?: string | null;

  // Convenience flag so list views can show voice-print status without
  // selecting the (large) voiceprint blob.
  @Column({ default: false })
  has_voiceprint: boolean;

  // S3 key of the audio clip the current voiceprint was created from (so the
  // UI can offer a "listen to reference" playback).
  @Column({ length: 512, nullable: true })
  sample_audio_path?: string | null;
}
