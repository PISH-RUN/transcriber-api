/**
 * Error type used across the audio pipeline so callers can distinguish
 * retryable transient failures (network / provider 5xx / timeouts) from
 * permanent ones (provider rejected the audio).
 */
export class ProcessingError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'ProcessingError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.cause = options.cause;
  }
}
