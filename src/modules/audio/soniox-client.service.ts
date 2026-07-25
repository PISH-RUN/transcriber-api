import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import axios from 'axios';
import * as FormData from 'form-data';
import { SonioxToken } from './transcript-merger.service';
import { ProcessingError } from './processing-errors';

const SONIOX_API_BASE_URL = 'https://api.soniox.com';

interface SonioxTranscriptResponse {
  tokens: SonioxToken[];
}

/**
 * Thin HTTP client around the Soniox async STT API (https://api.soniox.com):
 * upload a file, create a transcription job, poll it, fetch tokens, clean up.
 * Supports two transports: passing a public audio URL (Soniox fetches the
 * bytes server-side — the fast path) or uploading local bytes.
 */
@Injectable()
export class SonioxClientService {
  private readonly logger = new Logger(SonioxClientService.name);
  private readonly sonioxApiKey: string;

  constructor(private readonly configService: ConfigService) {
    this.sonioxApiKey = this.configService.get<string>('soniox.apiKey') || '';
    if (!this.sonioxApiKey) {
      this.logger.warn(
        'SONIOX_API_KEY is not configured — audio transcription will fail',
      );
    }
  }

  isConfigured(): boolean {
    return !!this.sonioxApiKey;
  }

  async uploadToSoniox(audioPath: string): Promise<string> {
    this.logger.log('Uploading audio to Soniox...');
    const form = new FormData();
    form.append('file', fs.createReadStream(audioPath));

    const response = await axios.post(`${SONIOX_API_BASE_URL}/v1/files`, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${this.sonioxApiKey}`,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    this.logger.log(`Soniox File ID: ${response.data.id}`);
    return response.data.id;
  }

  /**
   * Create a transcription job. Accepts either an uploaded `fileId` or a
   * public `audioUrl`.
   */
  async createSonioxTranscription(
    source: { fileId?: string; audioUrl?: string },
    reference: string,
  ): Promise<string> {
    if (!source.fileId && !source.audioUrl) {
      throw new Error('createSonioxTranscription: fileId or audioUrl required');
    }

    const config: Record<string, unknown> = {
      model: 'stt-async-v4',
      language_hints: ['fa'],
      enable_language_identification: true,
      enable_speaker_diarization: true,
      client_reference_id: `transcription_${reference}`,
      ...(source.audioUrl
        ? { audio_url: source.audioUrl }
        : { file_id: source.fileId }),
    };

    const response = await axios.post(
      `${SONIOX_API_BASE_URL}/v1/transcriptions`,
      config,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.sonioxApiKey}`,
        },
      },
    );

    this.logger.log(`Soniox Transcription ID: ${response.data.id}`);
    return response.data.id;
  }

  /**
   * Run a Soniox transcription against a publicly-reachable audio URL and
   * return the tokens. Cleans up the transcription afterwards.
   */
  async transcribeWithSonioxUrl(
    audioUrl: string,
    reference: string,
  ): Promise<{ tokens: SonioxToken[]; transcript: string }> {
    const transcriptionId = await this.createSonioxTranscription(
      { audioUrl },
      reference,
    );
    await this.waitForTranscription(transcriptionId);
    const { tokens, transcript } =
      await this.getTranscriptionWithTokens(transcriptionId);
    await this.deleteSonioxTranscription(transcriptionId);
    return { tokens, transcript };
  }

  /**
   * Upload a local file to Soniox, transcribe it and return tokens. Cleans up
   * both the transcription and the uploaded file afterwards.
   */
  async transcribeWithSonioxFile(
    audioPath: string,
    reference: string,
  ): Promise<{ tokens: SonioxToken[]; transcript: string }> {
    const fileId = await this.uploadToSoniox(audioPath);
    const transcriptionId = await this.createSonioxTranscription(
      { fileId },
      reference,
    );
    await this.waitForTranscription(transcriptionId);
    const { tokens, transcript } =
      await this.getTranscriptionWithTokens(transcriptionId);
    await this.deleteSonioxTranscription(transcriptionId);
    await this.deleteSonioxFile(fileId);
    return { tokens, transcript };
  }

  /**
   * Poll a Soniox async transcription until it completes. Bounded by
   * `maxWaitMs`; transient HTTP errors are retried until the deadline.
   */
  async waitForTranscription(
    transcriptionId: string,
    options: {
      maxWaitMs?: number;
      pollIntervalMs?: number;
      maxPollIntervalMs?: number;
    } = {},
  ): Promise<void> {
    const maxWaitMs = options.maxWaitMs ?? 30 * 60 * 1000; // 30 min
    const initialIntervalMs = options.pollIntervalMs ?? 2000;
    const maxIntervalMs = options.maxPollIntervalMs ?? 15000;

    const startedAt = Date.now();
    let intervalMs = initialIntervalMs;
    let lastError: unknown = null;

    for (;;) {
      const elapsed = Date.now() - startedAt;
      if (elapsed > maxWaitMs) {
        throw new ProcessingError(
          'SONIOX_TRANSCRIPTION_TIMEOUT',
          `Soniox transcription ${transcriptionId} did not complete within ${maxWaitMs}ms`,
          { retryable: true, cause: lastError },
        );
      }

      try {
        const response = await axios.get(
          `${SONIOX_API_BASE_URL}/v1/transcriptions/${transcriptionId}`,
          {
            headers: { Authorization: `Bearer ${this.sonioxApiKey}` },
            timeout: 15000,
          },
        );

        const status = response.data.status;
        if (status === 'completed') {
          this.logger.log(
            `Soniox transcription ${transcriptionId} completed in ${elapsed}ms`,
          );
          return;
        }
        if (status === 'error') {
          throw new ProcessingError(
            'SONIOX_TRANSCRIPTION_FAILED',
            `Transcription failed: ${response.data.error_message}`,
            { retryable: false },
          );
        }
      } catch (error: any) {
        if (error instanceof ProcessingError) throw error;
        lastError = error;
        this.logger.warn(
          `Transient error polling ${transcriptionId}: ${error?.message || error}`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      if (elapsed > 60_000 && intervalMs < maxIntervalMs) {
        intervalMs = Math.min(maxIntervalMs, intervalMs + 1000);
      }
    }
  }

  async getTranscriptionWithTokens(
    transcriptionId: string,
  ): Promise<{ tokens: SonioxToken[]; transcript: string }> {
    const response = await axios.get<SonioxTranscriptResponse>(
      `${SONIOX_API_BASE_URL}/v1/transcriptions/${transcriptionId}/transcript`,
      { headers: { Authorization: `Bearer ${this.sonioxApiKey}` } },
    );

    const tokens = response.data.tokens || [];
    return { tokens, transcript: this.renderTokens(tokens) };
  }

  /** Render Soniox tokens to readable text (fallback / debugging). */
  renderTokens(tokens: SonioxToken[]): string {
    return tokens.map((t) => t.text).join('');
  }

  async deleteSonioxTranscription(transcriptionId: string): Promise<void> {
    try {
      await axios.delete(
        `${SONIOX_API_BASE_URL}/v1/transcriptions/${transcriptionId}`,
        { headers: { Authorization: `Bearer ${this.sonioxApiKey}` } },
      );
    } catch (error) {
      this.logger.error('Error deleting Soniox transcription:', error);
    }
  }

  async deleteSonioxFile(fileId: string): Promise<void> {
    try {
      await axios.delete(`${SONIOX_API_BASE_URL}/v1/files/${fileId}`, {
        headers: { Authorization: `Bearer ${this.sonioxApiKey}` },
      });
    } catch (error) {
      this.logger.error('Error deleting Soniox file:', error);
    }
  }
}
