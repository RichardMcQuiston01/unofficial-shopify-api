import { describe, expect, it } from 'vitest';

import {
  NetworkError,
  err,
  mapResult,
  ok,
  tryAsync,
  type Result,
} from '../src/index.js';

describe('Result', () => {
  it('wraps a value with ok()', () => {
    expect(ok(5)).toEqual({ ok: true, value: 5 });
  });

  it('wraps an error with err()', () => {
    const error: NetworkError = new NetworkError('boom');
    expect(err(error)).toEqual({ ok: false, error });
  });

  it('maps successful values', () => {
    const result: Result<number> = ok(2);
    expect(mapResult(result, (value: number) => value * 3)).toEqual(ok(6));
  });

  it('passes errors through mapResult untouched', () => {
    const failure: Result<number> = err(new NetworkError('down'));
    expect(mapResult(failure, (value: number) => value * 3)).toBe(failure);
  });

  it('converts thrown values into Err via tryAsync', async () => {
    const result: Result<number, NetworkError> = await tryAsync(
      () => Promise.reject(new Error('socket hang up')),
      (thrown: unknown) => new NetworkError('Request failed', { cause: thrown })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.cause).toBeInstanceOf(Error);
    }
  });

  it('returns Ok from tryAsync on success', async () => {
    const result: Result<string, NetworkError> = await tryAsync(
      () => Promise.resolve('fine'),
      (thrown: unknown) => new NetworkError('unexpected', { cause: thrown })
    );
    expect(result).toEqual(ok('fine'));
  });
});
