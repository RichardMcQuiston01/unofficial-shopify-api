/** Helpers shared by the live checks in this folder. */
import { existsSync, readFileSync } from 'node:fs';
import type {
  Result,
  ShopifyError,
} from '@richardmcquiston01/unofficial-shopify-api';

export interface LiveCheckResult {
  readonly name: string;
  readonly status: 'pass' | 'fail' | 'skip';
  readonly detail: string;
}

export type Env = Readonly<Record<string, string | undefined>>;

export function describeError(error: ShopifyError): string {
  const requestId: string =
    error.context.requestId === undefined
      ? ''
      : ` [request ${error.context.requestId}]`;
  return `${error.code}: ${error.message}${requestId}`;
}

/** Runs one check, recording a pass with the returned detail or a fail with the error. */
export async function step(
  results: LiveCheckResult[],
  name: string,
  body: () => Promise<string>
): Promise<void> {
  try {
    results.push({ name, status: 'pass', detail: await body() });
  } catch (thrown: unknown) {
    const detail: string =
      thrown instanceof Error ? thrown.message : String(thrown);
    results.push({ name, status: 'fail', detail });
  }
}

/** Returns the value of an `Ok`, or throws an error that names the failure and request ID. */
export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(describeError(result.error));
  return result.value;
}

/** Prints results and returns a process exit code. */
export function printLiveCheck(results: readonly LiveCheckResult[]): number {
  for (const result of results) {
    console.log(
      `${result.status.toUpperCase().padEnd(5)} ${result.name}: ${result.detail}`
    );
  }
  return results.some(
    (result: LiveCheckResult): boolean => result.status === 'fail'
  )
    ? 1
    : 0;
}

/**
 * Fills a missing `SHOPIFY_ADMIN_TOKEN` from the git-ignored `.shopify-token`
 * file that `scripts/get-shopify-token.ps1` writes, so a new terminal does not
 * need the token set again. An environment variable always wins.
 */
export function withTokenFile(env: Env, path: string = '.shopify-token'): Env {
  if ((env['SHOPIFY_ADMIN_TOKEN'] ?? '') !== '' || !existsSync(path)) {
    return env;
  }
  const token: string = readFileSync(path, 'utf8').trim();
  return token === '' ? env : { ...env, SHOPIFY_ADMIN_TOKEN: token };
}
