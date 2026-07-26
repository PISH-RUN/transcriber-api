import { Column, Entity, JoinColumn, ManyToOne, OneToMany } from 'typeorm';
import { BaseTimestampEntity } from '../../common/abstracts/base.entity';
import { FileEntity } from '../file/file.entity';
import { Project } from '../project/project.entity';

export enum TranscriptionStatus {
  PENDING = 'pending', // created, queued for processing
  PROCESSING = 'processing', // STT + diarization + samples running
  AWAITING_MAPPING = 'awaiting_mapping', // ready for the user to confirm speakers
  COMPLETED = 'completed', // speakers confirmed, final text ready
  FAILED = 'failed',
}

/** Display/diarization info per detected speaker plus an auto-suggested match. */
export interface SpeakerSample {
  speakerId: string; // "SPEAKER_00"
  speakerLabel: string; // "گوینده 1"
  speakerNumber: number;
  audioPath: string; // S3 key of the sample clip
  totalDuration: number; // total seconds this speaker talks
  sampleStart: number;
  sampleEnd: number;
  suggestedPersonId?: number | null; // auto-match from voiceprint identify
  suggestedConfidence?: number | null;
}

@Entity('transcriptions')
export class Transcription extends BaseTimestampEntity {
  @Column({ length: 255 })
  title: string;

  // --- filing / searchable metadata, captured at upload time ---------------

  /** Free-text notes about the session. Searchable. */
  @Column({ type: 'text', nullable: true })
  description?: string | null;

  /**
   * When the session actually happened, as a calendar date — deliberately not a
   * timestamp, so it can't drift across timezones. `created_at` remains the
   * upload time.
   */
  @Column({ type: 'date', nullable: true })
  recorded_at?: string | null;

  /** Short free-form labels for filtering (e.g. ["جلسه هفتگی", "قطران"]). */
  @Column({ type: 'jsonb', nullable: true })
  tags?: string[] | null;

  /** The project this recording is filed under, if any. */
  @Column({ type: 'int', nullable: true })
  project_id?: number | null;
  @ManyToOne(() => Project, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'project_id' })
  project?: Project | null;

  @Column({
    type: 'enum',
    enum: TranscriptionStatus,
    default: TranscriptionStatus.PENDING,
  })
  status: TranscriptionStatus;

  @Column({ nullable: true })
  status_message?: string;

  @Column({ type: 'float', nullable: true })
  duration?: number;

  // Transcript with anonymous speaker labels ("گوینده 1 [..]: ...").
  @Column({ type: 'text', nullable: true })
  raw_text?: string;

  // Transcript with resolved person names, produced after speaker mapping.
  @Column({ type: 'text', nullable: true })
  final_text?: string;

  @Column({ nullable: true })
  diarization_source?: 'pyannote' | 'identify' | 'soniox' | 'none';

  // Raw Soniox tokens (large — excluded from default selects).
  @Column({ type: 'jsonb', nullable: true, select: false })
  stt_tokens?: Array<{
    text: string;
    start_ms: number;
    end_ms: number;
    speaker?: number;
  }>;

  // Pyannote diarization segments (large — excluded from default selects).
  @Column({ type: 'jsonb', nullable: true, select: false })
  diarization?: Array<{ start: number; end: number; speaker: string }>;

  // Merged, speaker-attributed segments used to render the conversation.
  @Column({ type: 'jsonb', nullable: true })
  segments?: Array<{
    speaker_id: string;
    speaker_label: string;
    text: string;
    start_time: string;
    end_time: string;
    start_ms: number;
    end_ms: number;
  }>;

  // --- AI proof-reading pass ---------------------------------------------
  // Status of the Gemini clean-up run over `segments`. Polled by the frontend.
  @Column({ nullable: true })
  refine_status?: 'processing' | 'done' | 'failed';

  @Column({ nullable: true })
  refine_message?: string;

  @Column({ type: 'timestamp', nullable: true })
  refined_at?: Date;

  // Snapshot of `segments` taken right before the last refinement, so the user
  // can go back to the raw STT text. Large — excluded from default selects.
  @Column({ type: 'jsonb', nullable: true, select: false })
  segments_before_refine?: Transcription['segments'];

  @Column({ type: 'jsonb', nullable: true })
  speaker_samples?: SpeakerSample[];

  @Column({ nullable: true })
  speaker_samples_status?: 'processing' | 'done' | 'failed';

  // Map of speaker_id -> person id (null = leave anonymous). Set on confirm.
  @Column({ type: 'jsonb', nullable: true })
  speaker_map?: Record<string, number | null>;

  // People the user expects to be present (drives voiceprint identification).
  @Column({ type: 'jsonb', nullable: true })
  expected_person_ids?: number[];

  /**
   * Speaker ids ("SPEAKER_00") belonging to the interviewer side — there may be
   * several. Evidence extraction needs this: an interviewer's own summary of
   * what the interviewee said must not be treated as a confirmed statement, and
   * nothing else in the data distinguishes asking from answering.
   */
  @Column({ type: 'jsonb', nullable: true })
  interviewer_speaker_ids?: string[] | null;

  // The single processed (merged + transcoded) MP3 we transcribe and play back.
  @Column({ nullable: true })
  processed_audio_id?: number;
  @ManyToOne(() => FileEntity, { eager: true, nullable: true })
  @JoinColumn({ name: 'processed_audio_id' })
  processed_audio?: FileEntity;

  @OneToMany(() => TranscriptionAudio, (audio) => audio.transcription)
  audioFiles: TranscriptionAudio[];
}

@Entity('transcription_audio_files')
export class TranscriptionAudio extends BaseTimestampEntity {
  @Column()
  transcription_id: number;
  @ManyToOne(() => Transcription, (t) => t.audioFiles, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'transcription_id' })
  transcription: Transcription;

  @Column()
  audio_id: number;
  @ManyToOne(() => FileEntity, { eager: true })
  @JoinColumn({ name: 'audio_id' })
  audio: FileEntity;

  @Column({ type: 'int', default: 1 })
  order: number;

  @Column({ length: 512, nullable: true })
  original_name?: string;
}
