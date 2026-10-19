import { describe, expect, it, vi, type Mock } from 'vitest';

import { inspect } from 'node:util';

import {
  HttpError,
  createAdminClient,
  createKeyValueSessionStorage,
  createStorefrontClient,
  createWebhookRouter,
  exchangeAuthorizationCode,
  exchangeIdToken,
  ok,
  refreshAccessToken,
  stageBulkMutationInput,
  validateIdToken,
  validateOAuthCallback,
  verifyWebhook,
  type AdminClient,
  type AdminClientOptions,
  type AppCredentials,
  type ConfigurationError,
  type SessionStorage,
  type StorefrontClient,
  type WebhookRouter,
  type AttemptInfo,
  type Logger,
  type Result,
  type ShopifyError,
} from '../src/index.js';
import { verifyHmac } from '../src/auth/crypto.js';
import {
  jsonResponse,
  scriptedClient,
  type ScriptedClient,
} from './helpers.js';
import { webhookHeaders, webhookSecret } from './webhook-helpers.js';

describe('empty secrets never throw and never validate', () => {
  it('verifyHmac treats an unusable key as a mismatch', async () => {
    expect(await verifyHmac('', 'message', new Uint8Array(32))).toBe(false);
  });

  it('webhook, OAuth and ID token checks return an Err that names the cause', async () => {
    const body: string = '{}';
    const webhook: Result<unknown> = await verifyWebhook(
      { rawBody: body, headers: webhookHeaders(body, {}, '') },
      ''
    );
    expect(!webhook.ok && webhook.error.message).toContain(
      'clientSecret is empty'
    );

    const callback: Result<unknown> = await validateOAuthCallback({
      query: 'code=a&hmac=00',
      clientSecret: ' ',
      expectedState: 'state-12345678',
    });
    expect(!callback.ok && callback.error.message).toContain(
      'clientSecret is empty'
    );

    const idToken: Result<unknown> = await validateIdToken('a.b.c', {
      clientId: 'client',
      clientSecret: '',
    });
    expect(!idToken.ok && idToken.error.message).toContain('is empty');
    const noClientId: Result<unknown> = await validateIdToken('a.b.c', {
      clientId: '',
      clientSecret: 'secret',
    });
    expect(noClientId.ok).toBe(false);
  });
});

describe('webhook age limit', () => {
  const body: string = '{"id":1}';
  const now: number = Date.parse('2026-10-19T00:10:00Z');

  async function check(
    headers: Record<string, string | undefined>,
    maxAgeSeconds?: number
  ): Promise<Result<unknown>> {
    return verifyWebhook(
      { rawBody: body, headers: webhookHeaders(body, headers) },
      webhookSecret,
      maxAgeSeconds === undefined
        ? {}
        : { maxAgeSeconds, now: (): number => now }
    );
  }

  it('is off by default, and accepts a recent delivery', async () => {
    expect(
      (await check({ 'X-Shopify-Triggered-At': '2020-01-01T00:00:00Z' })).ok
    ).toBe(true);
    expect(
      (await check({ 'X-Shopify-Triggered-At': '2026-10-19T00:09:00Z' }, 300))
        .ok
    ).toBe(true);
  });

  it('rejects stale, future, missing or invalid timestamps', async () => {
    for (const triggeredAt of [
      '2026-10-19T00:00:00Z',
      '2026-10-19T01:00:00Z',
      'yesterday',
      undefined,
    ]) {
      const result: Result<unknown> = await check(
        { 'X-Shopify-Triggered-At': triggeredAt },
        300
      );
      expect(!result.ok && result.error.message).toContain(
        'X-Shopify-Triggered-At'
      );
    }
  });

  it('is passed through by the router', async () => {
    const router: WebhookRouter = createWebhookRouter().on(
      'products/update',
      () => Promise.resolve(ok(undefined))
    );
    const stale: Result<unknown> = await router.handle(
      {
        rawBody: body,
        headers: webhookHeaders(body, {
          'X-Shopify-Triggered-At': '2020-01-01T00:00:00Z',
        }),
      },
      { clientSecret: webhookSecret, maxAgeSeconds: 60 }
    );
    expect(stale.ok).toBe(false);
  });
});

describe('redirects are never followed with credentials', () => {
  it('the Admin client reports a redirect, shows only its origin, and does not retry', async () => {
    const fetchMock: Mock<typeof fetch> = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response('', {
          status: 301,
          headers: {
            location: 'https://evil.example.com/steal?token=abc#frag',
          },
        })
      )
    );
    const created: Result<AdminClient, ConfigurationError> = createAdminClient({
      shop: 'example',
      accessToken: 'shpat_canary',
      apiVersion: '2026-10',
      fetch: fetchMock,
    });
    if (!created.ok) throw created.error;
    const result: Result<unknown> = await created.value.request('{ a }');
    expect(!result.ok && result.error).toBeInstanceOf(HttpError);
    const message: string = !result.ok ? result.error.message : '';
    expect(message).toContain('https://evil.example.com');
    expect(message).not.toContain('/steal');
    expect(message).not.toContain('token=abc');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe('manual');
  });

  it('the token endpoint does the same for the client secret', async () => {
    const fetchMock: Mock<typeof fetch> = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('', { status: 302 }))
    );
    const result: Result<unknown> = await exchangeAuthorizationCode(
      {
        shop: 'example',
        clientId: 'client',
        clientSecret: 'canary-secret',
        code: 'c',
      },
      { fetch: fetchMock }
    );
    expect(!result.ok && result.error.message).toContain('redirect');
    expect(!result.ok && result.error.message).toContain('unknown location');
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe('manual');
    const garbled: Mock<typeof fetch> = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response('', { status: 307, headers: { location: 'http://[' } })
      )
    );
    const second: Result<unknown> = await exchangeAuthorizationCode(
      {
        shop: 'example',
        clientId: 'client',
        clientSecret: 'canary-secret',
        code: 'c',
      },
      { fetch: garbled }
    );
    expect(!second.ok && second.error.message).toContain(
      'unparseable location'
    );
  });
});

describe('secrets never reach errors, logs or hooks', () => {
  const secrets: readonly string[] = [
    'shpat_CANARY_admin_token',
    'CANARY_client_secret',
    'shprt_CANARY_refresh_token',
    'CANARY_storefront_private',
    'CANARY_storefront_public',
  ];

  interface Observed {
    readonly lines: string[];
    readonly logger: Logger;
    readonly hooks: { onAttempt(info: AttemptInfo): void };
  }

  function observe(): Observed {
    const lines: string[] = [];
    const record = (
      message: string,
      context?: Readonly<Record<string, unknown>>
    ): void => {
      lines.push(JSON.stringify([message, context]));
    };
    return {
      lines,
      logger: { debug: record, info: record, warn: record, error: record },
      hooks: {
        onAttempt: (info: AttemptInfo): void => {
          lines.push(inspect(info, { depth: 6 }));
        },
      },
    };
  }

  function expectClean(failures: readonly unknown[], observed: Observed): void {
    expect(failures.length).toBeGreaterThan(0);
    const surfaces: string[] = [
      ...observed.lines,
      ...failures.map((failure: unknown): string =>
        inspect(failure, { depth: 8 })
      ),
      ...failures.map(
        (failure: unknown): string => (failure as ShopifyError).message
      ),
      ...failures.map((failure: unknown): string => JSON.stringify(failure)),
    ];
    for (const secret of secrets) {
      for (const surface of surfaces) expect(surface).not.toContain(secret);
    }
  }

  const failingResponses: readonly (() => Response | Error)[] = [
    (): Response => new Response('denied', { status: 401 }),
    (): Response => new Response('nope', { status: 403 }),
    (): Response =>
      new Response('slow down', {
        status: 429,
        headers: { 'retry-after': '1' },
      }),
    (): Response => new Response('bad gateway', { status: 502 }),
    (): Response => new Response('<html>', { status: 200 }),
    (): Response => jsonResponse({ errors: [{ message: 'boom' }] }),
    (): Response =>
      jsonResponse({
        errors: [{ message: 'x', extensions: { code: 'THROTTLED' } }],
      }),
    (): Response =>
      new Response('', {
        status: 301,
        headers: { location: 'https://other.example.com/' },
      }),
    (): Error => new TypeError('fetch failed'),
  ];

  it('holds for the Admin and Storefront clients across every failure path', async () => {
    const failures: unknown[] = [];
    const observed: Observed = observe();
    for (const make of failingResponses) {
      const fetchMock: Mock<typeof fetch> = vi.fn<typeof fetch>(() => {
        const outcome: Response | Error = make();
        return outcome instanceof Error
          ? Promise.reject(outcome)
          : Promise.resolve(outcome);
      });
      const shared: Omit<AdminClientOptions, 'accessToken'> = {
        shop: 'example',
        apiVersion: '2026-10',
        fetch: fetchMock,
        logger: observed.logger,
        hooks: observed.hooks,
        sleep: (): Promise<void> => Promise.resolve(),
        maxRetries: 1,
      };
      const clients: (AdminClient | { request: AdminClient['request'] })[] = [];
      const admin: Result<AdminClient, ConfigurationError> = createAdminClient({
        ...shared,
        accessToken: secrets[0] ?? '',
      });
      const privateClient: Result<StorefrontClient, ConfigurationError> =
        createStorefrontClient({
          ...shared,
          privateAccessToken: secrets[3] ?? '',
        });
      const publicClient: Result<StorefrontClient, ConfigurationError> =
        createStorefrontClient({
          ...shared,
          publicAccessToken: secrets[4] ?? '',
        });
      for (const created of [admin, privateClient, publicClient]) {
        if (created.ok) clients.push(created.value);
      }
      for (const client of clients) {
        const result: Result<unknown> = await client.request('{ a }', {
          operationName: 'Canary',
        });
        if (!result.ok) failures.push(result.error);
      }
    }
    expectClean(failures, observed);
  });

  it('holds for token grants, refresh and the signature checks', async () => {
    const failures: unknown[] = [];
    const observed: Observed = observe();
    for (const make of failingResponses) {
      const fetchMock: Mock<typeof fetch> = vi.fn<typeof fetch>(() => {
        const outcome: Response | Error = make();
        return outcome instanceof Error
          ? Promise.reject(outcome)
          : Promise.resolve(outcome);
      });
      const credentials: AppCredentials = {
        clientId: 'client',
        clientSecret: secrets[1] ?? '',
      };
      const results: Result<unknown>[] = [
        await exchangeAuthorizationCode(
          { ...credentials, shop: 'example', code: 'c' },
          { fetch: fetchMock }
        ),
        await exchangeIdToken(
          { ...credentials, shop: 'example', idToken: 'jwt' },
          { fetch: fetchMock }
        ),
        await refreshAccessToken(
          { ...credentials, shop: 'example', refreshToken: secrets[2] ?? '' },
          { fetch: fetchMock }
        ),
      ];
      for (const result of results) if (!result.ok) failures.push(result.error);
    }
    const secret: string = secrets[1] ?? '';
    for (const result of [
      await verifyWebhook(
        { rawBody: '{}', headers: webhookHeaders('{}', {}, 'other') },
        secret
      ),
      await validateOAuthCallback({
        query: 'code=a&state=s&shop=x.myshopify.com&hmac=00',
        clientSecret: secret,
        expectedState: 'state-12345678',
      }),
      await validateIdToken('not.a.jwt', {
        clientId: 'client',
        clientSecret: secret,
      }),
    ] as Result<unknown>[]) {
      if (!result.ok) failures.push(result.error);
    }
    expectClean(failures, observed);
  });

  it('holds for session storage and bulk upload failures', async () => {
    const failures: unknown[] = [];
    const observed: Observed = observe();
    const storage: SessionStorage = createKeyValueSessionStorage({
      get: () =>
        Promise.resolve({
          ok: false,
          code: 'unavailable',
          error: 'database is down',
        }),
      set: () =>
        Promise.resolve({
          ok: false,
          code: 'unavailable',
          error: 'database is down',
        }),
    });
    const stored: Result<unknown> = await storage.store({
      id: 'offline_example.myshopify.com',
      shop: 'example.myshopify.com',
      isOnline: false,
      accessToken: secrets[0] ?? '',
      scope: [],
      refreshToken: secrets[2] ?? '',
    });
    if (!stored.ok) failures.push(stored.error);
    const loaded: Result<unknown> = await storage.load(
      'offline_example.myshopify.com'
    );
    if (!loaded.ok) failures.push(loaded.error);

    const scripted: ScriptedClient = scriptedClient({
      StagedUploadsCreate: () => ({
        stagedUploadsCreate: {
          stagedTargets: [
            {
              url: 'https://upload.example.com/b?sig=x',
              parameters: [{ name: 'key', value: 'k' }],
            },
          ],
          userErrors: [],
        },
      }),
    });
    const upload: Result<unknown> = await stageBulkMutationInput(
      scripted.client,
      '{"a":1}',
      {
        fetch: () => Promise.resolve(new Response('denied', { status: 403 })),
      }
    );
    if (!upload.ok) failures.push(upload.error);
    expectClean(failures, observed);
  });
});
