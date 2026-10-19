import type { Sleep } from './types.js';

/** Parses `Retry-After` as delta-seconds or an HTTP date; undefined if absent or invalid. */
export function parseRetryAfterMs(
  headerValue: string | null,
  now: number = Date.now()
): number | undefined {
  if (headerValue === null) return undefined;
  const trimmed: string = headerValue.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.ceil(Number(trimmed) * 1000);
  const dateMs: number = Date.parse(trimmed);
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - now);
}

/** Exponential backoff with full jitter: random in [0, min(max, base * 2^(attempt-1))]. */
export function backoffDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number
): number {
  const ceiling: number = Math.min(
    maxDelayMs,
    baseDelayMs * 2 ** (attempt - 1)
  );
  return Math.floor(random() * ceiling);
}

function abortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error('The wait was aborted.');
}

/** Timer-based sleep that rejects with the signal's reason if aborted. */
export const defaultSleep: Sleep = (
  milliseconds: number,
  signal?: AbortSignal
): Promise<void> =>
  new Promise<void>(
    (resolve: () => void, reject: (reason: unknown) => void) => {
      if (signal?.aborted === true) {
        reject(abortError(signal));
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortError(signal));
      };
      const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, milliseconds);
      signal?.addEventListener('abort', onAbort, { once: true });
    }
  );
