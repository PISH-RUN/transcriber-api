import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';

/** A speaker segment from Pyannote diarization. */
export interface PyannoteSegment {
  start: number; // seconds
  end: number; // seconds
  speaker: string; // e.g. "SPEAKER_00"
}

/** A voiceprint to match against in an identify job. */
export interface PyannoteVoiceprintInput {
  label: string; // arbitrary label we get back on matches (we use the person id)
  voiceprint: string; // the voiceprint blob returned by /voiceprint
}

/** Per-speaker identification result from an identify job. */
export interface PyannoteSpeakerMatch {
  speaker: string; // diarization speaker id, e.g. "SPEAKER_00"
  match: string | null; // matched voiceprint label (our person id) or null
  confidence?: Record<string, number>;
}

export type PyannoteJobStatus =
  | 'pending'
  | 'created'
  | 'running'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'canceled';

interface PyannoteJobResponse {
  jobId: string;
  status: PyannoteJobStatus;
  output?: any;
  error?: string;
}

/**
 * Client for the pyannoteAI API (https://api.pyannote.ai/v1).
 *
 * Supports three async jobs, all following the same submit → poll /jobs/:id
 * pattern:
 *   - /diarize    → "who spoke when" (anonymous SPEAKER_00, SPEAKER_01, ...)
 *   - /voiceprint → a reusable voice signature for one known speaker
 *   - /identify   → diarization + matching each speaker to known voiceprints
 */
@Injectable()
export class PyannoteService {
  private readonly logger = new Logger(PyannoteService.name);
  private readonly baseUrl = 'https://api.pyannote.ai/v1';
  private readonly apiKey: string;
  private readonly enabled: boolean;
  private readonly maxRetries = 3;
  private readonly pollIntervalMs = 5000;
  private readonly maxWaitTimeMs = 30 * 60 * 1000; // 30 min
  private readonly model = 'precision-2';

  constructor(private configService: ConfigService) {
    this.apiKey = this.configService.get<string>('pyannote.apiKey') || '';
    this.enabled =
      this.configService.get<boolean>('pyannote.enabled') ?? false;
    if (!this.apiKey) {
      this.logger.warn(
        'PYANNOTE_API_KEY not configured. Diarization/identification unavailable.',
      );
    }
  }

  /** Pyannote is usable only when the feature flag is on AND a key exists. */
  isConfigured(): boolean {
    return this.enabled && !!this.apiKey;
  }

  // ---------------------------------------------------------------------------
  // Diarization
  // ---------------------------------------------------------------------------

  async getDiarization(audioUrl: string): Promise<PyannoteSegment[]> {
    const jobId = await this.submitWithRetry('/diarize', { url: audioUrl });
    const result = await this.waitForJob(jobId);
    const diarization: PyannoteSegment[] = result.output?.diarization ?? [];
    if (diarization.length === 0) {
      this.logger.warn(`No diarization data in job ${jobId}`);
    }
    return diarization;
  }

  // ---------------------------------------------------------------------------
  // Voiceprint creation
  // ---------------------------------------------------------------------------

  /**
   * Create a voiceprint from an audio clip containing a single speaker (<=30s).
   * Returns the opaque voiceprint blob to store on the person.
   */
  async createVoiceprint(audioUrl: string): Promise<string> {
    const jobId = await this.submitWithRetry('/voiceprint', {
      url: audioUrl,
      model: this.model,
    });
    const result = await this.waitForJob(jobId);
    const voiceprint: string | undefined = result.output?.voiceprint;
    if (!voiceprint) {
      throw new Error(`Pyannote voiceprint job ${jobId} returned no voiceprint`);
    }
    return voiceprint;
  }

  // ---------------------------------------------------------------------------
  // Identification (diarization + matching against known voiceprints)
  // ---------------------------------------------------------------------------

  /**
   * Run diarization + speaker identification against a set of known
   * voiceprints. Returns the (anonymous) diarization segments plus, for each
   * diarization speaker, which voiceprint label it matched (if any).
   */
  async identifySpeakers(
    audioUrl: string,
    voiceprints: PyannoteVoiceprintInput[],
    options: { threshold?: number; exclusive?: boolean } = {},
  ): Promise<{ diarization: PyannoteSegment[]; matches: PyannoteSpeakerMatch[] }> {
    if (!voiceprints || voiceprints.length === 0) {
      throw new Error('identifySpeakers requires at least one voiceprint');
    }

    // Pyannote allows 1-50 voiceprints per identify job.
    const trimmed = voiceprints.slice(0, 50);

    const jobId = await this.submitWithRetry('/identify', {
      url: audioUrl,
      model: this.model,
      voiceprints: trimmed,
      matching: {
        threshold: options.threshold ?? 0,
        exclusive: options.exclusive ?? true,
      },
    });

    const result = await this.waitForJob(jobId);
    const diarization: PyannoteSegment[] = result.output?.diarization ?? [];

    // Prefer the per-speaker `voiceprints` summary; fall back to deriving it
    // from the segment-level `identification` array.
    let matches: PyannoteSpeakerMatch[] = result.output?.voiceprints ?? [];
    if ((!matches || matches.length === 0) && result.output?.identification) {
      const bySpeaker = new Map<string, PyannoteSpeakerMatch>();
      for (const seg of result.output.identification) {
        const speaker = seg.speaker || seg.diarizationSpeaker;
        if (speaker && !bySpeaker.has(speaker)) {
          bySpeaker.set(speaker, {
            speaker,
            match: seg.match ?? null,
            confidence: seg.confidence,
          });
        }
      }
      matches = [...bySpeaker.values()];
    }

    return { diarization, matches };
  }

  // ---------------------------------------------------------------------------
  // Job plumbing
  // ---------------------------------------------------------------------------

  private async submitWithRetry(
    endpoint: string,
    body: Record<string, unknown>,
  ): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error('Pyannote is not configured/enabled');
    }

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await axios.post(`${this.baseUrl}${endpoint}`, body, {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
        });
        const jobId = response.data.jobId;
        this.logger.log(`Pyannote ${endpoint} job submitted: ${jobId}`);
        return jobId;
      } catch (error) {
        lastError = error as Error;
        if (!this.isRetryable(error) || attempt === this.maxRetries) {
          this.handleApiError(error, `submit ${endpoint}`);
          throw error;
        }
        const backoffMs = Math.pow(2, attempt) * 1000;
        this.logger.warn(
          `Pyannote ${endpoint} submit failed (attempt ${attempt}/${this.maxRetries}), retrying in ${backoffMs}ms`,
        );
        await this.sleep(backoffMs);
      }
    }
    throw lastError ?? new Error('Pyannote submission failed');
  }

  private async getJobStatus(jobId: string): Promise<PyannoteJobResponse> {
    const response = await axios.get(`${this.baseUrl}/jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    return {
      jobId: response.data.jobId,
      status: response.data.status,
      output: response.data.output,
      error: response.data.error,
    };
  }

  private async waitForJob(jobId: string): Promise<PyannoteJobResponse> {
    const startTime = Date.now();
    for (;;) {
      if (Date.now() - startTime > this.maxWaitTimeMs) {
        throw new Error(
          `Pyannote job ${jobId} timed out after ${this.maxWaitTimeMs / 60000} minutes`,
        );
      }

      const job = await this.getJobStatus(jobId);
      if (job.status === 'succeeded') {
        this.logger.log(`Pyannote job ${jobId} succeeded`);
        return job;
      }
      if (job.status === 'failed' || job.status === 'canceled') {
        throw new Error(
          `Pyannote job ${jobId} ${job.status}: ${job.error || 'unknown error'}`,
        );
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  private isRetryable(error: unknown): boolean {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      if (status === 429 || (status && status >= 500)) return true;
      if (axiosError.code === 'ECONNRESET' || axiosError.code === 'ETIMEDOUT') {
        return true;
      }
    }
    return false;
  }

  private handleApiError(error: unknown, operation: string): void {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const data = axiosError.response?.data;
      this.logger.error(
        `Pyannote API error in ${operation}: ${status} - ${JSON.stringify(data)}`,
      );
    } else {
      this.logger.error(`Pyannote error in ${operation}:`, error);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
