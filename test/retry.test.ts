import { describe, expect, it } from 'vitest';

import {
  backoffDelayMs,
  defaultSleep,
  parseRetryAfterMs,
} from '../src/client/retry.js';

describe('parseRetryAfterMs', () => {
  it('parses seconds', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
    expect(parseRetryAfterMs('0.5')).toBe(500);
  });

  it('parses HTTP dates relative to now', () => {
    const now: number = Date.parse('2026-10-19T00:00:00Z');
    expect(parseRetryAfterMs('Mon, 19 Oct 2026 00:00:03 GMT', now)).toBe(3000);
    expect(parseRetryAfterMs('Mon, 19 Oct 2026 00:00:00 GMT', now + 5000)).toBe(
      0
    );
  });

  it('returns undefined for missing or invalid values', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('soon')).toBeUndefined();
  });
});

describe('backoffDelayMs', () => {
  it('grows exponentially, is capped, and applies jitter', () => {
    expect(backoffDelayMs(1, 500, 10_000, () => 1 - Number.EPSILON)).toBe(499);
    expect(backoffDelayMs(3, 500, 10_000, () => 0.5)).toBe(1000);
    expect(backoffDelayMs(10, 500, 1_000, () => 0.5)).toBe(500);
    expect(backoffDelayMs(2, 500, 10_000, () => 0)).toBe(0);
  });
});

describe('defaultSleep', () => {
  it('resolves after the delay', async () => {
    await expect(defaultSleep(1)).resolves.toBeUndefined();
  });

  it('rejects immediately when already aborted', async () => {
    const controller: AbortController = new AbortController();
    controller.abort();
    await expect(defaultSleep(1000, controller.signal)).rejects.toBeInstanceOf(
      Error
    );
  });

  it('rejects when aborted while waiting', async () => {
    const controller: AbortController = new AbortController();
    const pending: Promise<void> = defaultSleep(60_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(Error);
  });
});
