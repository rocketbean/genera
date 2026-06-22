import { RateLimitError, UnavailableError } from "./errors";

export interface RetryInfo {
  /** 1-based attempt number that just failed. */
  attempt: number;
  error: unknown;
  /** Milliseconds the layer will wait before the next attempt. */
  delayMs: number;
}

export interface RetryOptions {
  /** Total attempts including the first. Default 3. */
  maxAttempts?: number;
  /** Base backoff in ms (doubled each attempt). Default 100. */
  baseDelayMs?: number;
  /** Backoff ceiling in ms. Default 5000. */
  maxDelayMs?: number;
  /** Apply random jitter (±50%) to computed delays. Default true. */
  jitter?: boolean;
  /** Decide whether an error is worth retrying. Default: rate-limit/unavailable/network. */
  isRetryable?: (error: unknown) => boolean;
  /** Called before each backoff wait. */
  onRetry?: (info: RetryInfo) => void;
  /** Injectable sleep (tests pass an instant one). */
  sleep?: (ms: number) => Promise<void>;
}

/** Default retry predicate: provider rate limits, transient unavailability, and network blips. */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof RateLimitError || error instanceof UnavailableError) return true;
  const code = (error as { code?: string } | undefined)?.code;
  if (code === "RATE_LIMITED" || code === "UNAVAILABLE") return true;
  // A failed `fetch` rejects with a TypeError; Node socket errors carry these codes.
  if (error instanceof TypeError) return true;
  return code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EAI_AGAIN";
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying transient failures with exponential backoff + jitter. A
 * `RateLimitError.retryAfterMs` overrides the computed delay (respecting the
 * provider's `Retry-After`). Non-retryable errors and the final attempt rethrow.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 100;
  const maxDelayMs = options.maxDelayMs ?? 5000;
  const jitter = options.jitter ?? true;
  const isRetryable = options.isRetryable ?? isRetryableError;
  const sleep = options.sleep ?? defaultSleep;

  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryable(error)) throw error;
      const retryAfter = error instanceof RateLimitError ? error.retryAfterMs : undefined;
      let delayMs = retryAfter ?? Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      // Jitter only the computed backoff — honor an explicit Retry-After exactly.
      if (jitter && retryAfter === undefined) {
        delayMs = Math.round(delayMs * (0.5 + Math.random() / 2));
      }
      options.onRetry?.({ attempt, error, delayMs });
      await sleep(delayMs);
    }
  }
}
