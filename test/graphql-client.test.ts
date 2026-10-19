import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  type AttemptInfo,
  type Logger,
  type Result,
  type AdminResponse,
} from '../src/index.js';
import { jsonResponse, makeClient, type TestClient } from './helpers.js';

function headersOf(
  fetchMock: Mock<typeof fetch>,
  call: number
): Record<string, string> {
  return (fetchMock.mock.calls[call]?.[1]?.headers ?? {}) as Record<
    string,
    string
  >;
}

describe('custom headers', () => {
  it('sends client and request headers for tracing', async () => {
    const { client, fetchMock }: TestClient = makeClient({
      headers: { 'X-Request-ID': 'client-level', traceparent: 'tp-1' },
    });
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ data: {} }))
    );
    await client.request('{ a }', {
      headers: { 'x-request-id': 'request-level' },
    });
    expect(headersOf(fetchMock, 0)).toMatchObject({
      'x-request-id': 'request-level',
      traceparent: 'tp-1',
      'X-Shopify-Access-Token': 'shpat_secret_token',
    });
    expect(
      Object.keys(headersOf(fetchMock, 0)).filter(
        (name: string): boolean => name.toLowerCase() === 'x-request-id'
      )
    ).toHaveLength(1);
  });

  it('never lets caller headers replace the credential or content type', async () => {
    const { client, fetchMock }: TestClient = makeClient({
      headers: {
        'x-shopify-access-token': 'attacker',
        'content-type': 'text/plain',
      },
    });
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ data: {} }))
    );
    await client.request('{ a }', {
      headers: { 'X-SHOPIFY-ACCESS-TOKEN': 'attacker-2', ACCEPT: 'text/html' },
    });
    const headers: Record<string, string> = headersOf(fetchMock, 0);
    const lowered: string[] = Object.keys(headers).map((name: string): string =>
      name.toLowerCase()
    );
    expect(new Set(lowered).size).toBe(lowered.length);
    expect(headers['X-Shopify-Access-Token']).toBe('shpat_secret_token');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Accept']).toBe('application/json');
  });
});

describe('hooks.onAttempt', () => {
  it('reports every attempt including retries, with request IDs', async () => {
    const attempts: AttemptInfo[] = [];
    const { client, fetchMock }: TestClient = makeClient({
      hooks: {
        onAttempt: (info: AttemptInfo): void => void attempts.push(info),
      },
    });
    fetchMock
      .mockResolvedValueOnce(
        new Response('', { status: 502, headers: { 'x-request-id': 'r1' } })
      )
      .mockResolvedValueOnce(
        jsonResponse({ data: {} }, { headers: { 'x-request-id': 'r2' } })
      );
    const result: Result<AdminResponse<unknown>> = await client.request(
      '{ a }',
      {
        operationName: 'Probe',
      }
    );
    expect(result.ok).toBe(true);
    expect(
      attempts.map((info: AttemptInfo): unknown => [
        info.operation,
        info.attempt,
        info.ok,
        info.status,
        info.requestId,
      ])
    ).toEqual([
      ['Probe', 1, false, 502, 'r1'],
      ['Probe', 2, true, undefined, 'r2'],
    ]);
    expect(attempts[0]?.error?.code).toBe('HTTP');
    expect(attempts[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('ignores a throwing hook and logs it', async () => {
    const warnings: string[] = [];
    const logger: Logger = {
      debug: (): void => undefined,
      info: (): void => undefined,
      warn: (message: string): void => void warnings.push(message),
      error: (): void => undefined,
    };
    const { client, fetchMock }: TestClient = makeClient({
      logger,
      hooks: {
        onAttempt: (): void => {
          throw new Error('metrics down');
        },
      },
    });
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));
    const result: Result<AdminResponse<unknown>> =
      await client.request('{ a }');
    expect(result.ok).toBe(true);
    expect(warnings).toContain('onAttempt hook threw; ignoring');
  });

  it('works when the thrown value is not an Error', async () => {
    const { client, fetchMock }: TestClient = makeClient({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      hooks: {
        onAttempt: (): void => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- hooks may throw anything.
          throw 'plain';
        },
      },
    });
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: {} }));
    expect((await client.request('{ a }')).ok).toBe(true);
  });
});
