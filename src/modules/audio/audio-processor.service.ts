import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import ffmpeg from '../../libs/ffmpeg/ffmpeg.util';

/**
 * Pure audio operations built on ffmpeg: transcoding, merging, probing
 * duration and extracting clips. No domain knowledge (no DB, no providers) —
 * the orchestration lives in TranscriptionService.
 */
@Injectable()
export class AudioProcessorService {
  private readonly logger = new Logger(AudioProcessorService.name);
  private readonly tempDir = path.join(process.cwd(), 'temp', 'audio');

  constructor() {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  get workDir(): string {
    return this.tempDir;
  }

  private tempPath(suffix: string): string {
    return path.join(
      this.tempDir,
      `${Date.now()}_${Math.round(Math.random() * 1e6)}_${suffix}`,
    );
  }

  /**
   * Transcode any uploaded audio/video into a streaming-friendly, byte-range
   * seekable MP3 (mono, 32 kHz, Xing seek header). This becomes the single
   * processed artifact we store, transcribe, diarize and play back — so
   * analysis timestamps stay 1:1 with playback.
   */
  async transcodeToStreamingMp3(inputPath: string): Promise<string> {
    if (!fs.existsSync(inputPath)) {
      throw new Error(`Audio file not found at ${inputPath}`);
    }
    const outputPath = this.tempPath('processed.mp3');

    return new Promise<string>((resolve, reject) => {
      ffmpeg(inputPath)
        .noVideo()
        .audioCodec('libmp3lame')
        .audioBitrate('96k')
        .audioFrequency(32000)
        .audioChannels(1)
        .outputOptions(['-write_xing', '1', '-id3v2_version', '3'])
        .on('end', () => {
          this.logger.log(
            `Transcoded ${path.basename(inputPath)} → ${path.basename(outputPath)}`,
          );
          resolve(outputPath);
        })
        .on('error', (err) => {
          this.safeUnlink(outputPath);
          reject(err);
        })
        .save(outputPath);
    });
  }

  /**
   * Merge multiple local audio files (in order) into a single streaming MP3
   * using the ffmpeg concat demuxer. Returns the merged path and per-file
   * durations (seconds).
   */
  async mergeAudioFiles(
    localPaths: string[],
  ): Promise<{ mergedPath: string; durations: number[] }> {
    if (localPaths.length === 0) {
      throw new Error('mergeAudioFiles requires at least one file');
    }

    // Normalize each input to the same codec/rate/channels first so concat is
    // clean regardless of the original formats.
    const normalized: string[] = [];
    const durations: number[] = [];
    for (let i = 0; i < localPaths.length; i++) {
      const out = this.tempPath(`merge_part_${i}.mp3`);
      await new Promise<void>((resolve, reject) => {
        ffmpeg(localPaths[i])
          .noVideo()
          .audioCodec('libmp3lame')
          .audioBitrate('96k')
          .audioFrequency(32000)
          .audioChannels(1)
          .on('end', () => resolve())
          .on('error', (err) => reject(err))
          .save(out);
      });
      normalized.push(out);
      durations.push(await this.getAudioDuration(out));
    }

    const concatListPath = this.tempPath('concat.txt');
    // ffmpeg concat needs escaped, absolute paths.
    const concatContent = normalized
      .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
      .join('\n');
    fs.writeFileSync(concatListPath, concatContent);

    const mergedPath = this.tempPath('merged.mp3');
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(concatListPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .audioCodec('libmp3lame')
        .audioFrequency(32000)
        .audioChannels(1)
        .outputOptions(['-write_xing', '1'])
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .save(mergedPath);
    });

    this.safeUnlink(concatListPath);
    normalized.forEach((p) => this.safeUnlink(p));

    this.logger.log(
      `Merged ${localPaths.length} files → ${path.basename(mergedPath)} (${durations
        .reduce((a, b) => a + b, 0)
        .toFixed(1)}s)`,
    );
    return { mergedPath, durations };
  }

  /**
   * Probe audio duration in seconds. Falls back to a WAV transcode when the
   * container lacks duration metadata (e.g. some browser webm recordings).
   */
  async getAudioDuration(filePath: string): Promise<number> {
    const standard = await new Promise<number | null>((resolve) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) return resolve(null);
        if (metadata.format.duration && !isNaN(metadata.format.duration)) {
          return resolve(metadata.format.duration);
        }
        const audioStream = metadata.streams?.find(
          (s) => s.codec_type === 'audio',
        );
        if (audioStream?.duration && !isNaN(parseFloat(audioStream.duration))) {
          return resolve(parseFloat(audioStream.duration));
        }
        resolve(null);
      });
    });

    if (standard && standard > 0) return standard;

    this.logger.warn('Duration not in metadata, transcoding to measure it...');
    const tempWav = this.tempPath('duration.wav');
    return new Promise<number>((resolve) => {
      ffmpeg(filePath)
        .toFormat('wav')
        .on('end', () => {
          ffmpeg.ffprobe(tempWav, (err, metadata) => {
            this.safeUnlink(tempWav);
            if (err || !metadata.format.duration) return resolve(0);
            resolve(metadata.format.duration);
          });
        })
        .on('error', () => {
          this.safeUnlink(tempWav);
          resolve(0);
        })
        .save(tempWav);
    });
  }

  /**
   * Extract a mono 16 kHz MP3 clip from a source (local path or URL) between
   * `startSec` and `startSec + durationSec`. Used for per-speaker samples and
   * voiceprint source clips. Returns the local clip path.
   */
  async extractClip(
    source: string,
    startSec: number,
    durationSec: number,
    label = 'clip',
  ): Promise<string> {
    const outputPath = this.tempPath(`${label}.mp3`);
    await new Promise<void>((resolve, reject) => {
      ffmpeg(source)
        .setStartTime(startSec)
        .setDuration(durationSec)
        .audioCodec('libmp3lame')
        .audioFrequency(16000)
        .audioChannels(1)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .save(outputPath);
    });
    return outputPath;
  }

  /** Download a remote (presigned) URL to a local MP3 via ffmpeg. */
  async downloadToLocalMp3(url: string, label = 'download'): Promise<string> {
    const outputPath = this.tempPath(`${label}.mp3`);
    await new Promise<void>((resolve, reject) => {
      ffmpeg(url)
        .audioCodec('libmp3lame')
        .audioFrequency(32000)
        .audioChannels(1)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .save(outputPath);
    });
    return outputPath;
  }

  safeUnlink(filePath?: string | null): void {
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        /* ignore */
      }
    }
  }
}
