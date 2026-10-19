import { describe, expect, it, vi } from 'vitest';

import {
  AuthenticationError,
  GraphqlError,
  HttpError,
  NetworkError,
  ThrottledError,
  type AdminResponse,
  type Logger,
  type Result,
  type ShopifyError,
  type TypedDocument,
} from '../src/index.js';
import { jsonResponse, makeClient, type TestClient } from './helpers.js';

const productQuery: string = 'query Shop { shop { name } }';
const productMutation: string =
  'mutation Create($input: ProductInput!) { productCreate(input: $input) { product { id } } }';

type RequestResult = Result<AdminResponse<unknown>>;
type ShopData = { shop: { name: string } };

function expectError(result: Result<unknown>): ShopifyError {
  if (result.ok) throw new Error('Expected an Err result.');
  return result.error;
}

describe('request: success', () => {
  it('posts to the versioned endpoint with the token header', async () => {
    const { client, fetchMock }: TestClient = makeClient();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          data: { shop: { name: 'Example' } },
          extensions: {
            cost: {
              requestedQueryCost: 1,
              actualQueryCost: 1,
              throttleStatus: {
                maximumAvailable: 2000,
                currentlyAvailable: 1999,
                restoreRate: 100,
              },
            },
          },
        },
        { headers: { 'x-request-id': 'req-123' } }
      )
    );

    const result: Result<AdminResponse<ShopData>> =
      await client.request<ShopData>(productQuery, {
        variables: { first: 1 },
        operationName: 'Shop',
      });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.shop.name).toBe('Example');
    expect(result.value.requestId).toBe('req-123');
    expect(result.value.attempts).toBe(1);
    expect(result.value.cost?.throttleStatus.currentlyAvailable).toBe(1999);

    const [url, init]: Parameters<typeof fetch> = fetchMock.mock
      .calls[0] as Parameters<typeof fetch>;
    expect(url).toBe(
      'https://example.myshopify.com/admin/api/2026-10/graphql.json'
    );
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      'X-Shopify-Access-Token': 'shpat_secret_token',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      query: productQuery,
      variables: { first: 1 },
      operationName: 'Shop',
    });
  });

  it('accepts a typed document object', async () => {
    const { client, fetchMock }: TestClient = makeClient();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { shop: { name: 'Typed' } } })
    );
    const document: TypedDocument<ShopData> = {
      toString: (): string => productQuery,
    };

    const result: Result<AdminResponse<ShopData>> =
      await client.request(document);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.data.shop.name).toBe('Typed');
  });
});

describe('request: HTTP failures', () => {
  it('maps 401 to AuthenticationError without leaking the token', async () => {
    const { client, fetchMock }: TestClient = makeClient();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { errors: '[API] Invalid API key or access token' },
        {
          status: 401,
          headers: { 'x-request-id': 'req-401' },
        }
      )
    );

    const error: ShopifyError = expectError(
      await client.request(productQuery, { operationName: 'Shop' })
    );

    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.context).toMatchObject({
      status: 401,
      requestId: 'req-401',
      shop: 'example.myshopify.com',
      operation: 'Shop',
    });
    expect(error.message).toContain('Shop on example.myshopify.com');
    expect(error.message).not.toContain('shpat_secret_token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('explains a 404 as a bad shop or API version', async () => {
    const { client, fetchMock }: TestClient = makeClient();
    fetchMock.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    const error: ShopifyError = expectError(await client.request(productQuery));
    expect(error).toBeInstanceOf(HttpError);
    expect(error.message).toContain('apiVersion');
  });

  it('retries 429 using Retry-After and then succeeds', async () => {
    const { client, fetchMock, sleeps }: TestClient = makeClient();
    fetchMock
      .mockResolvedValueOnce(
        new Response('', { status: 429, headers: { 'retry-after': '2' } })
      )
      .mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));

    const result: RequestResult = await client.request(productQuery);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.attempts).toBe(2);
    expect(sleeps).toEqual([2000]);
  });

  it('gives up when Retry-After exceeds maxRetryDelayMs', async () => {
    const { client, fetchMock, sleeps }: TestClient = makeClient({
      maxRetryDelayMs: 1000,
    });
    fetchMock.mockResolvedValueOnce(
      new Response('', { status: 429, headers: { 'retry-after': '30' } })
    );
    const error: ShopifyError = expectError(await client.request(productQuery));
    expect(error).toBeInstanceOf(ThrottledError);
    expect((error as ThrottledError).retryAfterMs).toBe(30_000);
    expect(sleeps).toEqual([]);
  });

  it('retries 5xx on queries with backoff, then reports the last error', async () => {
    const { client, fetchMock, sleeps }: TestClient = makeClient({
      maxRetries: 2,
    });
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response('Bad Gateway', { status: 502 }))
    );

    const error: ShopifyError = expectError(await client.request(productQuery));

    expect(error).toBeInstanceOf(HttpError);
    expect(error.context.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([250, 500]);
  });

  it('does not retry 5xx on mutations, which may have run', async () => {
    const { client, fetchMock, sleeps }: TestClient = makeClient();
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
    const error: ShopifyError = expectError(
      await client.request(productMutation)
    );
    expect(error).toBeInstanceOf(HttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('still retries a throttled mutation, which Shopify did not run', async () => {
    const { client, fetchMock }: TestClient = makeClient();
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(
        jsonResponse({ data: { productCreate: { product: { id: '1' } } } })
      );
    const result: RequestResult = await client.request(productMutation);
    expect(result.ok).toBe(true);
  });

  it('reports a 200 response that is not JSON', async () => {
    const { client, fetchMock }: TestClient = makeClient();
    fetchMock.mockResolvedValueOnce(
      new Response('<html>maintenance</html>', { status: 200 })
    );
    const error: ShopifyError = expectError(await client.request(productQuery));
    expect(error).toBeInstanceOf(HttpError);
    expect(error.message).toContain('not valid JSON');
    expect(error.message).toContain('maintenance');
  });

  it('reports a body with neither data nor errors', async () => {
    const { client, fetchMock }: TestClient = makeClient();
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    const error: ShopifyError = expectError(await client.request(productQuery));
    expect(error.message).toContain('neither "data" nor "errors"');
  });
});

describe('request: GraphQL errors', () => {
  it('maps top-level errors to GraphqlError', async () => {
    const { client, fetchMock }: TestClient = makeClient();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        errors: [{ message: "Field 'nope' doesn't exist on type 'Shop'" }],
      })
    );
    const error: ShopifyError = expectError(
      await client.request(productQuery, { operationName: 'Shop' })
    );
    expect(error).toBeInstanceOf(GraphqlError);
    expect((error as GraphqlError).errors).toHaveLength(1);
    expect(error.message).toContain("Field 'nope'");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps ACCESS_DENIED to AuthenticationError naming the scope problem', async () => {
    const { client, fetchMock }: TestClient = makeClient();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        errors: [
          {
            message: 'Access denied for orders field.',
            extensions: { code: 'ACCESS_DENIED' },
          },
        ],
      })
    );
    const error: ShopifyError = expectError(await client.request(productQuery));
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.message).toContain('access scope');
  });

  it('waits for the cost bucket to refill on THROTTLED, then retries', async () => {
    const { client, fetchMock, sleeps }: TestClient = makeClient();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
          extensions: {
            cost: {
              requestedQueryCost: 600,
              actualQueryCost: null,
              throttleStatus: {
                maximumAvailable: 1000,
                currentlyAvailable: 100,
                restoreRate: 50,
              },
            },
          },
        })
      )
      .mockResolvedValueOnce(jsonResponse({ data: { shop: { name: 'A' } } }));

    const result: RequestResult = await client.request(productQuery);

    expect(result.ok).toBe(true);
    expect(sleeps).toEqual([10_000]);
  });

  it('falls back to backoff when THROTTLED carries no cost', async () => {
    const { client, fetchMock, sleeps }: TestClient = makeClient({
      maxRetries: 1,
    });
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
        })
      )
    );
    const error: ShopifyError = expectError(await client.request(productQuery));
    expect(error).toBeInstanceOf(ThrottledError);
    expect(sleeps).toEqual([250]);
  });
});

describe('request: network failures', () => {
  it('retries a network error on queries', async () => {
    const { client, fetchMock }: TestClient = makeClient();
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse({ data: { shop: { name: 'A' } } }));
    const result: RequestResult = await client.request(productQuery);
    expect(result.ok).toBe(true);
  });

  it('does not retry a network error on mutations', async () => {
    const { client, fetchMock }: TestClient = makeClient();
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const error: ShopifyError = expectError(
      await client.request(productMutation)
    );
    expect(error).toBeInstanceOf(NetworkError);
    expect(error.message).toContain('fetch failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a mutation keyword inside a comment or string as a query', async () => {
    const { client, fetchMock }: TestClient = makeClient();
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse({ data: {} }));
    const result: RequestResult = await client.request(
      '# not a mutation\nquery Q { shop(note: "mutation") { name } }'
    );
    expect(result.ok).toBe(true);
  });

  it('describes timeouts', async () => {
    const { client, fetchMock }: TestClient = makeClient({ maxRetries: 0 });
    const timeout: DOMException = new DOMException('timed out', 'TimeoutError');
    fetchMock.mockRejectedValueOnce(timeout);
    const error: ShopifyError = expectError(await client.request(productQuery));
    expect(error).toBeInstanceOf(NetworkError);
    expect(error.message).toContain('timed out');
    expect(error.cause).toBe(timeout);
  });

  it('does not retry when the caller aborted', async () => {
    const { client, fetchMock, sleeps }: TestClient = makeClient();
    const controller: AbortController = new AbortController();
    controller.abort();
    fetchMock.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));
    const error: ShopifyError = expectError(
      await client.request(productQuery, { signal: controller.signal })
    );
    expect(error.message).toContain('aborted by the caller');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('reports an abort that happens while waiting to retry', async () => {
    const controller: AbortController = new AbortController();
    const { client, fetchMock }: TestClient = makeClient({
      sleep: (): Promise<void> => {
        controller.abort();
        return Promise.reject(new Error('aborted'));
      },
    });
    fetchMock.mockResolvedValueOnce(new Response('', { status: 429 }));
    const error: ShopifyError = expectError(
      await client.request(productQuery, { signal: controller.signal })
    );
    expect(error).toBeInstanceOf(NetworkError);
  });

  it('reports a failure while reading the body', async () => {
    const { client, fetchMock }: TestClient = makeClient({ maxRetries: 0 });
    const broken: Response = new Response('x', { status: 200 });
    vi.spyOn(broken, 'text').mockRejectedValue(new Error('socket closed'));
    fetchMock.mockResolvedValueOnce(broken);
    const error: ShopifyError = expectError(await client.request(productQuery));
    expect(error).toBeInstanceOf(NetworkError);
    expect(error.message).toContain('reading the response body');
  });

  it('per-request maxRetries overrides the client setting', async () => {
    const { client, fetchMock }: TestClient = makeClient();
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response('', { status: 500 }))
    );
    await client.request(productQuery, { maxRetries: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('request: logging', () => {
  it('never logs the access token', async () => {
    const calls: string[] = [];
    const record = (
      message: string,
      context?: Readonly<Record<string, unknown>>
    ): void => {
      calls.push(JSON.stringify([message, context]));
    };
    const logger: Logger = {
      debug: record,
      info: record,
      warn: record,
      error: record,
    };
    const { client, fetchMock }: TestClient = makeClient({ logger });
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 502 }))
      .mockResolvedValueOnce(jsonResponse({ data: {} }));

    await client.request(productQuery);

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.join('\n')).not.toContain('shpat_secret_token');
  });
});
