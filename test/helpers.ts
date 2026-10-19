import { vi, type Mock } from 'vitest';

import {
  createAdminClient,
  type AdminClient,
  type AdminClientOptions,
  type ConfigurationError,
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
