import { vi, type Mock } from 'vitest';

import {
  ShopifyError,
  createAdminClient,
  err,
  ok,
  type AdminClient,
  type AdminClientOptions,
  type AdminResponse,
  type ConfigurationError,
  type GraphqlClient,
  type GraphqlDocument,
  type GraphqlRequestOptions,
  type Result,
} from '../src/index.js';

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

export interface TestClient {
  readonly client: AdminClient;
  readonly fetchMock: Mock<typeof fetch>;
  readonly sleeps: number[];
}

export function makeClient(
  overrides: Partial<AdminClientOptions> = {}
): TestClient {
  const fetchMock: Mock<typeof fetch> = vi.fn<typeof fetch>();
  const sleeps: number[] = [];
  const created: Result<AdminClient, ConfigurationError> = createAdminClient({
    shop: 'example',
    accessToken: 'shpat_secret_token',
    apiVersion: '2026-10',
    fetch: fetchMock,
    sleep: (milliseconds: number): Promise<void> => {
      sleeps.push(milliseconds);
      return Promise.resolve();
    },
    random: (): number => 0.5,
    ...overrides,
  });
  if (!created.ok) throw created.error;
  return { client: created.value, fetchMock, sleeps };
}

/** Returns a copy of `value` without `key`. */
export function omit<T extends object, K extends keyof T>(
  value: T,
  key: K
): Omit<T, K> {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([name]: [string, unknown]): boolean => name !== key
    )
  ) as Omit<T, K>;
}

export interface ScriptedCall {
  readonly operation: string;
  readonly document: string;
  readonly variables: Record<string, unknown>;
  readonly headers: Record<string, string> | undefined;
}

export type Responder = (
  variables: Record<string, unknown>,
  callNumber: number
) => unknown;

export interface ScriptedClient {
  readonly client: GraphqlClient;
  readonly calls: ScriptedCall[];
}

/**
 * A GraphQL client whose answers come from per-operation functions. A
 * responder may return data, or a `ShopifyError` to fail the call.
 */
export function scriptedClient(
  responders: Readonly<Record<string, Responder>>
): ScriptedClient {
  const calls: ScriptedCall[] = [];
  const request = (
    document: GraphqlDocument,
    options: GraphqlRequestOptions = {}
  ): Promise<Result<AdminResponse<unknown>>> => {
    const operation: string = options.operationName ?? '';
    const variables: Record<string, unknown> = { ...(options.variables ?? {}) };
    const callNumber: number = calls.filter(
      (call: ScriptedCall): boolean => call.operation === operation
    ).length;
    calls.push({
      operation,
      document: String(document),
      variables,
      headers:
        options.headers === undefined ? undefined : { ...options.headers },
    });
    const responder: Responder | undefined = responders[operation];
    if (responder === undefined) {
      return Promise.reject(new Error(`No responder for ${operation}`));
    }
    const answer: unknown = responder(variables, callNumber);
    if (answer instanceof ShopifyError) return Promise.resolve(err(answer));
    return Promise.resolve(
      ok({ data: answer, cost: undefined, requestId: undefined, attempts: 1 })
    );
  };
  return {
    client: {
      shop: 'example.myshopify.com',
      apiVersion: '2026-10',
      request: request as GraphqlClient['request'],
    },
    calls,
  };
}
