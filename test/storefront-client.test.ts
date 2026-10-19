import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  ConfigurationError,
  createStorefrontClient,
  mergeHeaders,
  type AdminResponse,
  type Result,
  type StorefrontClient,
  type StorefrontClientOptions,
} from '../src/index.js';
import { jsonResponse } from './helpers.js';

interface Setup {
  readonly client: StorefrontClient;
  readonly fetchMock: Mock<typeof fetch>;
}

function setup(overrides: Partial<StorefrontClientOptions> = {}): Setup {
  const fetchMock: Mock<typeof fetch> = vi.fn<typeof fetch>(() =>
    Promise.resolve(jsonResponse({ data: { shop: { name: 'S' } } }))
  );
  const created: Result<StorefrontClient, ConfigurationError> =
    createStorefrontClient({
      shop: 'example',
      apiVersion: '2026-10',
      fetch: fetchMock,
      ...overrides,
    });
  if (!created.ok) throw created.error;
  return { client: created.value, fetchMock };
}

function sentHeaders(fetchMock: Mock<typeof fetch>): Record<string, string> {
  return (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<
    string,
    string
  >;
}

describe('createStorefrontClient', () => {
  it('posts to the Storefront endpoint with a public token', async () => {
    const { client, fetchMock }: Setup = setup({
      publicAccessToken: 'public-1',
    });
    const result: Result<AdminResponse<unknown>> =
      await client.request('{ shop { name } }');
    expect(result.ok).toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://example.myshopify.com/api/2026-10/graphql.json'
    );
    expect(sentHeaders(fetchMock)).toMatchObject({
      'X-Shopify-Storefront-Access-Token': 'public-1',
      'Content-Type': 'application/json',
    });
    expect(client.shop).toBe('example.myshopify.com');
  });

  it('sends a private token in its own header', async () => {
    const { client, fetchMock }: Setup = setup({
      privateAccessToken: 'private-1',
    });
    await client.request('{ shop { name } }');
    const headers: Record<string, string> = sentHeaders(fetchMock);
    expect(headers['Shopify-Storefront-Private-Token']).toBe('private-1');
    expect(headers['X-Shopify-Storefront-Access-Token']).toBeUndefined();
  });

  it('works without a token for tokenless access', async () => {
    const { client, fetchMock }: Setup = setup();
    await client.request('{ shop { name } }');
    const names: string[] = Object.keys(sentHeaders(fetchMock)).map(
      (name: string): string => name.toLowerCase()
    );
    expect(names).not.toContain('x-shopify-storefront-access-token');
    expect(names).not.toContain('shopify-storefront-private-token');
  });

  it('adds the buyer IP for a request when it is a valid address', async () => {
    const { client, fetchMock }: Setup = setup({ privateAccessToken: 'p' });
    await client.request('{ shop { name } }', { buyerIp: '203.0.113.7' });
    await client.request('{ shop { name } }', { buyerIp: '2001:db8::1' });
    await client.request('{ shop { name } }');
    const headersOf = (index: number): Record<string, string> =>
      (fetchMock.mock.calls[index]?.[1]?.headers ?? {}) as Record<
        string,
        string
      >;
    expect(headersOf(0)['Shopify-Storefront-Buyer-IP']).toBe('203.0.113.7');
    expect(headersOf(1)['Shopify-Storefront-Buyer-IP']).toBe('2001:db8::1');
    expect(headersOf(2)['Shopify-Storefront-Buyer-IP']).toBeUndefined();
  });

  it('refuses a malformed buyer IP without calling Shopify', async () => {
    const { client, fetchMock }: Setup = setup({ privateAccessToken: 'p' });
    const result: Result<AdminResponse<unknown>> = await client.request(
      '{ a }',
      {
        buyerIp: '1.2.3.4\r\nX-Evil: 1',
      }
    );
    expect(!result.ok && result.error).toBeInstanceOf(ConfigurationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      { publicAccessToken: 'a', privateAccessToken: 'b' },
      'both a public and a private',
    ],
    [{ publicAccessToken: ' ' }, 'is empty'],
    [{ privateAccessToken: '' }, 'is empty'],
    [{ shop: 'evil.com' }, 'myshopify.com'],
    [{ apiVersion: 'latest' }, 'apiVersion'],
    [{ timeoutMs: -1 }, 'timeoutMs'],
  ])('refuses invalid options %j', (override: object, expected: string) => {
    const result: Result<StorefrontClient, ConfigurationError> =
      createStorefrontClient({
        shop: 'example',
        apiVersion: '2026-10',
        fetch: vi.fn<typeof fetch>(),
        ...override,
      });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain(expected);
  });

  it('does not expose the token', () => {
    const { client }: Setup = setup({
      privateAccessToken: 'super-secret-private',
    });
    expect(JSON.stringify(client)).not.toContain('super-secret-private');
  });
});

describe('mergeHeaders', () => {
  it('lets later sources win regardless of case', () => {
    expect(
      mergeHeaders({ 'x-request-id': 'a', Accept: 'text/plain' }, undefined, {
        'X-Request-Id': 'b',
        accept: 'application/json',
      })
    ).toEqual({ 'X-Request-Id': 'b', accept: 'application/json' });
  });
});
