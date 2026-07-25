import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GOOGLE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

const DEFAULT_MODEL = {
  openrouter: 'google/gemini-2.5-flash',
  google: 'gemini-2.5-flash',
};

export interface CompletionRequest {
  system: string;
  user: string;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** Ask the model for a raw JSON object (no prose, no code fences). */
  json?: boolean;
}

/**
 * Minimal Gemini 2.5 Flash client.
 *
 * Works with either transport, so it fits whichever key the deployment has:
 *  - `OPENROUTER_API_KEY` -> OpenRouter chat completions (`google/gemini-2.5-flash`)
 *  - `GEMINI_API_KEY`     -> Google AI Studio generateContent (`gemini-2.5-flash`)
 *
 * "Thinking" is switched off on both paths: this is a text-cleanup task, and
 * reasoning tokens count against the output budget, which can otherwise cut a
 * long answer short.
 */
@Injectable()
export class GeminiService {
  private readonly logger = new Logger(GeminiService.name);

  private readonly openrouterApiKey: string;
  private readonly googleApiKey: string;
  private readonly modelOverride: string;
  private readonly referer: string;
  private readonly title: string;

  constructor(private readonly configService: ConfigService) {
    const config = this.configService.get('llm') ?? {};
    this.openrouterApiKey = config.openrouterApiKey || '';
    this.googleApiKey = config.googleApiKey || '';
    this.modelOverride = config.refineModel || '';
    this.referer = config.openrouterReferer || '';
    this.title = config.openrouterTitle || '';

    if (!this.isConfigured()) {
      this.logger.warn(
        'Neither OPENROUTER_API_KEY nor GEMINI_API_KEY is set — AI transcript refinement is disabled',
      );
    }
  }

  get provider(): 'openrouter' | 'google' | null {
    if (this.openrouterApiKey) return 'openrouter';
    if (this.googleApiKey) return 'google';
    return null;
  }

  get model(): string {
    const provider = this.provider;
    if (!provider) return '';
    return this.modelOverride || DEFAULT_MODEL[provider];
  }

  isConfigured(): boolean {
    return this.provider !== null;
  }

  /**
   * One-shot completion. Retries twice on rate limits / transient server
   * errors with a short backoff.
   */
  async complete(request: CompletionRequest): Promise<string> {
    const provider = this.provider;
    if (!provider) {
      throw new Error(
        'کلید سرویس هوش مصنوعی تنظیم نشده است (OPENROUTER_API_KEY یا GEMINI_API_KEY)',
      );
    }

    const maxAttempts = 3;
    let lastError: any = null;
    let json = request.json === true;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const attemptRequest = { ...request, json };
        return provider === 'openrouter'
          ? await this.callOpenRouter(attemptRequest)
          : await this.callGoogle(attemptRequest);
      } catch (error: any) {
        lastError = error;
        const status = error?.response?.status;

        // Some providers reject the JSON-mode hint. The parser tolerates prose
        // and code fences anyway, so drop the hint and try once more.
        if (status === 400 && json) {
          this.logger.warn('LLM rejected JSON mode — retrying as plain text');
          json = false;
          continue;
        }

        const retryable =
          status === 429 ||
          status === 408 ||
          (status >= 500 && status < 600) ||
          error?.code === 'ECONNABORTED' ||
          error?.code === 'ECONNRESET';

        if (!retryable || attempt === maxAttempts) break;

        const waitMs = 1500 * attempt;
        this.logger.warn(
          `LLM call failed (${status ?? error?.code ?? error?.message}) — retrying in ${waitMs}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }

    const detail =
      lastError?.response?.data?.error?.message ||
      lastError?.response?.data?.message ||
      lastError?.message ||
      'unknown error';
    throw new Error(`خطا در فراخوانی سرویس هوش مصنوعی: ${detail}`);
  }

  private async callOpenRouter(request: CompletionRequest): Promise<string> {
    const response = await axios.post(
      OPENROUTER_URL,
      {
        model: this.model,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxOutputTokens ?? 8192,
        ...(request.json ? { response_format: { type: 'json_object' } } : {}),
        // No `reasoning` param on purpose: OpenRouter keeps Gemini 2.5 Flash
        // thinking off unless it is explicitly requested, and sending an
        // unsupported reasoning config would just risk a 400.
      },
      {
        timeout: request.timeoutMs ?? 120000,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.openrouterApiKey}`,
          ...(this.referer ? { 'HTTP-Referer': this.referer } : {}),
          ...(this.title ? { 'X-Title': this.title } : {}),
        },
      },
    );

    const message = response.data?.choices?.[0]?.message;
    const content = Array.isArray(message?.content)
      ? message.content.map((part: any) => part?.text ?? '').join('')
      : message?.content;

    if (!content) {
      throw new Error(
        `پاسخ خالی از مدل (${response.data?.choices?.[0]?.finish_reason ?? 'no finish_reason'})`,
      );
    }
    return String(content);
  }

  private async callGoogle(request: CompletionRequest): Promise<string> {
    const response = await axios.post(
      `${GOOGLE_URL}/${this.model}:generateContent?key=${encodeURIComponent(this.googleApiKey)}`,
      {
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: 'user', parts: [{ text: request.user }] }],
        generationConfig: {
          temperature: request.temperature ?? 0.2,
          maxOutputTokens: request.maxOutputTokens ?? 8192,
          ...(request.json ? { responseMimeType: 'application/json' } : {}),
          thinkingConfig: { thinkingBudget: 0 },
        },
      },
      {
        timeout: request.timeoutMs ?? 120000,
        headers: { 'Content-Type': 'application/json' },
      },
    );

    const candidate = response.data?.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .map((part: any) => part?.text ?? '')
      .join('');

    if (!text) {
      throw new Error(
        `پاسخ خالی از مدل (${candidate?.finishReason ?? 'no finishReason'})`,
      );
    }
    return text;
  }
}
