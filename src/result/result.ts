import type { ShopifyError } from '../errors/errors.js';

/** Successful outcome carrying a value. */
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

/** Failed outcome carrying an error. Callers must check `ok` before use. */
export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

/** Return type for every fallible operation in this library. */
export type Result<T, E extends Error = ShopifyError> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E extends Error>(error: E): Err<E> {
  return { ok: false, error };
}

/** Transforms the value of a successful result; errors pass through. */
export function mapResult<T, U, E extends Error>(
  result: Result<T, E>,
  transform: (value: T) => U
): Result<U, E> {
  return result.ok ? ok(transform(result.value)) : result;
}

/**
 * Runs `operation` and converts any thrown value into an `Err` using
 * `toError`, so unexpected exceptions never escape to the caller.
 */
export async function tryAsync<T, E extends Error>(
  operation: () => Promise<T>,
  toError: (thrown: unknown) => E
): Promise<Result<T, E>> {
  try {
    return ok(await operation());
  } catch (thrown: unknown) {
    return err(toError(thrown));
  }
}
