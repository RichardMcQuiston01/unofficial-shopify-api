import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createMemorySessionStorage,
  offlineSessionId,
  type Result,
  type Session,
  type SessionStorage,
  type SyncReport,
  type AdminClient,
} from '@richardmcquiston01/unofficial-shopify-api';
import {
  configFromEnv,
  type AppConfig,
  type AppContext,
} from '../examples/app.js';
import {
  authenticateAdmin,
  unauthorized,
  type AuthenticatedRequest,
} from '../examples/embedded.js';
import {
  printLiveCheck,
  runLiveCheck,
  type LiveCheckResult,
} from '../examples/live-check.js';
import { createDevApp } from '../examples/dev-server.js';
import { runLiveBulkMutation } from '../examples/live-bulk-mutation.js';
import { beginInstall, finishInstall } from '../examples/oauth.js';
import { exportProductTitles, listProducts } from '../examples/products.js';
import {
  createWebhookHandler,
  subscribeToWebhooks,
} from '../examples/webhooks.js';
import {
  fakeShopify,
  type FakeCall,
  type FakeShopify,
} from './fake-shopify.js';

const config: AppConfig = {
  clientId: 'client-1',
  clientSecret: 'client-secret',
  scopes: ['read_products', 'write_products'],
  appUrl: 'https://app.example.com',
  apiVersion: '2026-10',
};
const shop: string = 'example.myshopify.com';

function setup(): {
  context: AppContext;
  fake: FakeShopify;
  sessions: SessionStorage;
} {
  const fake: FakeShopify = fakeShopify();
  const sessions: SessionStorage = createMemorySessionStorage();
  return { context: { config, sessions, fetch: fake.fetch }, fake, sessions };
}

function signedCallback(
  fields: Record<string, string>,
  secret: string = config.clientSecret
): string {
  const sorted: [string, string][] = Object.entries(fields).sort(
    ([a]: [string, string], [b]: [string, string]): number => (a < b ? -1 : 1)
  );
  const hmac: string = createHmac('sha256', secret)
    .update(new URLSearchParams(sorted).toString())
    .digest('hex');
  return new URLSearchParams([...sorted, ['hmac', hmac]]).toString();
}

const b64u = (value: string | Buffer): string =>
  Buffer.from(value).toString('base64url');

function idToken(overrides: Record<string, unknown> = {}): string {
  const now: number = Math.floor(Date.now() / 1000);
  const head: string = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body: string = b64u(
    JSON.stringify({
      iss: `https://${shop}/admin`,
      dest: `https://${shop}`,
      aud: config.clientId,
      sub: '42',
      exp: now + 60,
      nbf: now - 5,
      ...overrides,
    })
  );
  return `${head}.${body}.${createHmac('sha256', config.clientSecret).update(`${head}.${body}`).digest('base64url')}`;
}

describe('configFromEnv', () => {
  it('reads the environment and names a missing variable', () => {
    const env: Record<string, string> = {
      SHOPIFY_CLIENT_ID: 'id',
      SHOPIFY_CLIENT_SECRET: 'secret',
      SHOPIFY_SCOPES: 'read_products, write_products',
      APP_URL: 'https://app.example.com',
      SHOPIFY_API_VERSION: '2026-10',
    };
    const ok: Result<AppConfig> = configFromEnv(env);
    expect(ok.ok && ok.value.scopes).toEqual([
      'read_products',
      'write_products',
    ]);
    const missing: Result<AppConfig> = configFromEnv({
      ...env,
      SHOPIFY_CLIENT_SECRET: ' ',
    });
    expect(!missing.ok && missing.error.message).toContain(
      'SHOPIFY_CLIENT_SECRET'
    );
  });
});

describe('standalone OAuth install', () => {
  it('redirects to Shopify with a state that is also saved in a cookie', () => {
    const { context } = setup();
    const response: Response = beginInstall(
      new Request(`https://app.example.com/api/auth/install?shop=example`),
      context
    );
    expect(response.status).toBe(302);
    const location: URL = new URL(response.headers.get('location') ?? '');
    expect(location.origin + location.pathname).toBe(
      `https://${shop}/admin/oauth/authorize`
    );
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://app.example.com/api/auth/callback'
    );
    const cookie: string = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(
      `shopify_oauth_state=${location.searchParams.get('state') ?? 'missing'}`
    );
    expect(cookie).toMatch(/HttpOnly.*Secure|Secure.*HttpOnly/);
  });

  it('refuses a shop that is not a myshopify.com domain', () => {
    const { context } = setup();
    expect(
      beginInstall(
        new Request('https://app.example.com/api/auth/install?shop=evil.com'),
        context
      ).status
    ).toBe(400);
    expect(
      beginInstall(
        new Request('https://app.example.com/api/auth/install'),
        context
      ).status
    ).toBe(400);
  });

  it('completes the install: verifies the callback, exchanges the code, stores the session', async () => {
    const { context, fake, sessions } = setup();
    const query: string = signedCallback({
      code: 'auth-code',
      shop,
      state: 'state-abcdef123456',
      timestamp: String(Math.floor(Date.now() / 1000)),
    });
    const response: Response = await finishInstall(
      new Request(`https://app.example.com/api/auth/callback?${query}`, {
        headers: { cookie: 'other=1; shopify_oauth_state=state-abcdef123456' },
      }),
      context
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    const form: URLSearchParams | undefined = fake.calls.find((call) =>
      call.form?.has('code')
    )?.form;
    expect(form?.get('code')).toBe('auth-code');
    expect(form?.get('expiring')).toBe('1');
    const stored: Result<Session | null> = await sessions.load(
      offlineSessionId(shop)
    );
    expect(stored.ok && stored.value?.accessToken).toBe('shpat_fake_1');
    expect(stored.ok && stored.value?.refreshToken).toBe('shprt_fake_1');
  });

  it('rejects a forged, replayed or cookie-less callback and does not call Shopify', async () => {
    const { context, fake } = setup();
    const fresh: string = String(Math.floor(Date.now() / 1000));
    const good: string = signedCallback({
      code: 'c',
      shop,
      state: 'state-abcdef123456',
      timestamp: fresh,
    });
    const attempts: [string, string][] = [
      [
        signedCallback(
          { code: 'c', shop, state: 'state-abcdef123456', timestamp: fresh },
          'wrong-secret'
        ),
        'shopify_oauth_state=state-abcdef123456',
      ],
      [good, 'shopify_oauth_state=another-state-0000'],
      [good, ''],
      [
        good.replace('code=c', 'code=stolen'),
        'shopify_oauth_state=state-abcdef123456',
      ],
      [
        signedCallback({
          code: 'c',
          shop,
          state: 'state-abcdef123456',
          timestamp: '1000',
        }),
        'shopify_oauth_state=state-abcdef123456',
      ],
    ];
    for (const [query, cookie] of attempts) {
      const response: Response = await finishInstall(
        new Request(`https://app.example.com/api/auth/callback?${query}`, {
          headers: { cookie },
        }),
        context
      );
      expect(response.status).toBe(401);
    }
    expect(fake.calls).toEqual([]);
  });

  it('reports a failed code exchange as a bad gateway', async () => {
    const fake: FakeShopify = fakeShopify({ tokenStatus: 400 });
    const context: AppContext = {
      config,
      sessions: createMemorySessionStorage(),
      fetch: fake.fetch,
    };
    const query: string = signedCallback({
      code: 'c',
      shop,
      state: 'state-abcdef123456',
      timestamp: String(Math.floor(Date.now() / 1000)),
    });
    const response: Response = await finishInstall(
      new Request(`https://app.example.com/api/auth/callback?${query}`, {
        headers: { cookie: 'shopify_oauth_state=state-abcdef123456' },
      }),
      context
    );
    expect(response.status).toBe(502);
  });
});

describe('embedded app authentication', () => {
  async function authenticate(
    context: AppContext,
    token: string
  ): Promise<Result<AuthenticatedRequest>> {
    return authenticateAdmin(
      new Request('https://app.example.com/api/products', {
        headers: { authorization: `Bearer ${token}` },
      }),
      context
    );
  }

  it('exchanges the ID token once, then reuses the stored session', async () => {
    const { context, fake } = setup();
    const first: Result<AuthenticatedRequest> = await authenticate(
      context,
      idToken()
    );
    expect(first.ok && first.value.shop).toBe(shop);
    const exchange: URLSearchParams | undefined = fake.calls.find((call) =>
      call.form?.has('subject_token')
    )?.form;
    expect(exchange?.get('requested_token_type')).toBe(
      'urn:shopify:params:oauth:token-type:offline-access-token'
    );

    await authenticate(context, idToken());
    expect(fake.calls.filter((call) => call.form !== undefined)).toHaveLength(
      1
    );

    if (first.ok)
      await first.value.client.request('{ shop { name } }', {
        operationName: 'LiveShop',
      });
    const graphqlCall: FakeCall | undefined = fake.calls.find((call) =>
      call.url.includes('/admin/api/')
    );
    expect(graphqlCall?.headers.get('x-shopify-access-token')).toBe(
      'shpat_fake_1'
    );
  });

  it('refreshes an expired expiring token with the refresh token', async () => {
    const { context, fake, sessions } = setup();
    const expired: Session = {
      id: offlineSessionId(shop),
      shop,
      isOnline: false,
      accessToken: 'shpat_old',
      scope: ['read_products'],
      expiresAt: Date.now() - 1000,
      refreshToken: 'shprt_old',
      refreshTokenExpiresAt: Date.now() + 86_400_000,
    };
    await sessions.store(expired);
    const result: Result<AuthenticatedRequest> = await authenticate(
      context,
      idToken()
    );
    expect(result.ok && result.value.session.accessToken).toBe('shpat_fake_1');
    const refresh: URLSearchParams | undefined = fake.calls.find(
      (call) => call.form?.get('grant_type') === 'refresh_token'
    )?.form;
    expect(refresh?.get('refresh_token')).toBe('shprt_old');
    const stored: Result<Session | null> = await sessions.load(
      offlineSessionId(shop)
    );
    expect(stored.ok && stored.value?.refreshToken).toBe('shprt_fake_1');
  });

  it('falls back to a token exchange when the refresh token no longer works', async () => {
    const { context, fake, sessions } = setup();
    await sessions.store({
      id: offlineSessionId(shop),
      shop,
      isOnline: false,
      accessToken: 'shpat_old',
      scope: [],
      expiresAt: Date.now() - 1000,
      refreshToken: 'shprt_expired',
      refreshTokenExpiresAt: Date.now() - 1000,
    });
    const result: Result<AuthenticatedRequest> = await authenticate(
      context,
      idToken()
    );
    expect(result.ok).toBe(true);
    expect(
      fake.calls.some(
        (call) => call.form?.get('grant_type') === 'refresh_token'
      )
    ).toBe(false);
    expect(
      fake.calls.some((call) => call.form?.has('subject_token') === true)
    ).toBe(true);
  });

  it('answers 401 with the retry header for a bad, expired or missing ID token', async () => {
    const { context, fake } = setup();
    for (const token of [
      '',
      'garbage',
      idToken({ exp: Math.floor(Date.now() / 1000) - 600 }),
      idToken({ aud: 'other-app' }),
    ]) {
      const result: Result<AuthenticatedRequest> = await authenticate(
        context,
        token
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const response: Response = unauthorized(result.error);
        expect(response.status).toBe(401);
        expect(
          response.headers.get('X-Shopify-Retry-Invalid-Session-Request')
        ).toBe('1');
      }
    }
    expect(fake.calls).toEqual([]);
  });

  it('passes a failed exchange back to the caller', async () => {
    const fake: FakeShopify = fakeShopify({ tokenStatus: 400 });
    const context: AppContext = {
      config,
      sessions: createMemorySessionStorage(),
      fetch: fake.fetch,
    };
    expect((await authenticate(context, idToken())).ok).toBe(false);
  });
});

describe('webhook route', () => {
  function post(
    body: string,
    overrides: Record<string, string> = {},
    secret: string = config.clientSecret
  ): Request {
    return new Request('https://app.example.com/api/webhooks', {
      method: 'POST',
      body,
      headers: {
        'X-Shopify-Hmac-Sha256': createHmac('sha256', secret)
          .update(body)
          .digest('base64'),
        'X-Shopify-Topic': 'products/update',
        'X-Shopify-Shop-Domain': shop,
        'X-Shopify-Webhook-Id': 'delivery-1',
        'X-Shopify-Triggered-At': new Date().toISOString(),
        ...overrides,
      },
    });
  }

  it('answers 200 for a valid delivery and for a repeat of it', async () => {
    const { context } = setup();
    const handle: (request: Request) => Promise<Response> =
      createWebhookHandler(context);
    const body: string = JSON.stringify({ id: 1, title: 'Hat' });
    expect((await handle(post(body))).status).toBe(200);
    expect((await handle(post(body))).status).toBe(200);
  });

  it('answers 401 for a bad signature and for an old delivery', async () => {
    const { context } = setup();
    const handle: (request: Request) => Promise<Response> =
      createWebhookHandler(context);
    expect((await handle(post('{"id":1}', {}, 'wrong-secret'))).status).toBe(
      401
    );
    expect(
      (
        await handle(
          post('{"id":1}', { 'X-Shopify-Triggered-At': '2020-01-01T00:00:00Z' })
        )
      ).status
    ).toBe(401);
  });

  it('removes the shop sessions when the app is uninstalled', async () => {
    const { context, sessions } = setup();
    await sessions.store({
      id: offlineSessionId(shop),
      shop,
      isOnline: false,
      accessToken: 'x',
      scope: [],
    });
    const handle: (request: Request) => Promise<Response> =
      createWebhookHandler(context);
    const response: Response = await handle(
      post('{"myshopify_domain":"example.myshopify.com"}', {
        'X-Shopify-Topic': 'app/uninstalled',
        'X-Shopify-Webhook-Id': 'delivery-2',
      })
    );
    expect(response.status).toBe(200);
    const stored: Result<Session | null> = await sessions.load(
      offlineSessionId(shop)
    );
    expect(stored.ok && stored.value).toBeNull();
  });

  it('subscribes once and is idempotent', async () => {
    const { context, fake } = setup();
    const client: Result<AuthenticatedRequest> = await authenticateAdmin(
      new Request('https://app.example.com/x', {
        headers: { authorization: `Bearer ${idToken()}` },
      }),
      context
    );
    if (!client.ok) throw client.error;
    const first: Result<SyncReport> = await subscribeToWebhooks(
      client.value.client,
      context
    );
    expect(first.ok && first.value.created).toHaveLength(2);
    const second: Result<SyncReport> = await subscribeToWebhooks(
      client.value.client,
      context
    );
    expect(second.ok && second.value.unchanged).toHaveLength(2);
    expect(fake.webhookSubscriptions.map((item) => item['topic'])).toEqual([
      'APP_UNINSTALLED',
      'PRODUCTS_UPDATE',
    ]);
  });
});

describe('product examples', () => {
  async function adminClient(context: AppContext): Promise<AdminClient> {
    const result: Result<AuthenticatedRequest> = await authenticateAdmin(
      new Request('https://app.example.com/x', {
        headers: { authorization: `Bearer ${idToken()}` },
      }),
      context
    );
    if (!result.ok) throw result.error;
    return result.value.client;
  }

  it('pages through products', async () => {
    const { context } = setup();
    const products: Result<{ id: string; title: string }[]> =
      await listProducts(await adminClient(context));
    expect(
      products.ok && products.value.map((product) => product.title)
    ).toEqual(['Hat', 'Scarf']);
  });

  it('exports titles through a bulk operation', async () => {
    const { context } = setup();
    const titles: string[] = [];
    const result: Result<number> = await exportProductTitles(
      await adminClient(context),
      (title: string): void => void titles.push(title),
      { fetch: context.fetch as typeof fetch }
    );
    expect(result.ok && result.value).toBe(3);
    expect(titles).toEqual(['Hat', 'Scarf', 'Mitten']);
  });
});

describe('live check', () => {
  const env: Record<string, string> = {
    SHOPIFY_SHOP: 'example',
    SHOPIFY_API_VERSION: '2026-10',
    SHOPIFY_ADMIN_TOKEN: 'shpat_x',
  };

  it('passes every step against a healthy shop', async () => {
    const fake: FakeShopify = fakeShopify();
    const results: LiveCheckResult[] = await runLiveCheck(env, {
      fetch: fake.fetch,
    });
    expect(results.map((result) => [result.name, result.status])).toEqual([
      ['admin: shop query', 'pass'],
      ['admin: pagination (2 pages of 5 products)', 'pass'],
      ['admin: webhook subscriptions', 'pass'],
      ['admin: bulk query + streamed results', 'pass'],
      ['storefront: products query (tokenless)', 'pass'],
    ]);
    expect(results[0]?.detail).toContain('Fake Shop');
    expect(results[3]?.detail).toContain('3 row(s) read');
    expect(printLiveCheck(results)).toBe(0);
  });

  it('uses a Storefront token when one is given', async () => {
    const fake: FakeShopify = fakeShopify();
    const results: LiveCheckResult[] = await runLiveCheck(
      { ...env, STOREFRONT_PRIVATE_TOKEN: 'p' },
      { fetch: fake.fetch }
    );
    expect(results.at(-1)?.name).toContain('private token');
    const publicResults: LiveCheckResult[] = await runLiveCheck(
      { ...env, STOREFRONT_PUBLIC_TOKEN: 'q' },
      { fetch: fake.fetch }
    );
    expect(publicResults.at(-1)?.name).toContain('public token');
  });

  it('skips Admin checks without a token, and fails clearly without a shop', async () => {
    const fake: FakeShopify = fakeShopify();
    const skipped: LiveCheckResult[] = await runLiveCheck(
      { SHOPIFY_SHOP: 'example', SHOPIFY_API_VERSION: '2026-10' },
      { fetch: fake.fetch }
    );
    expect(skipped[0]?.status).toBe('skip');
    const failed: LiveCheckResult[] = await runLiveCheck(
      {},
      { fetch: fake.fetch }
    );
    expect(failed[0]?.status).toBe('fail');
    expect(printLiveCheck(failed)).toBe(1);
  });

  it('reports failures with the request ID and an invalid client', async () => {
    const rejecting: FakeShopify = fakeShopify({ rejectAdmin: true });
    const results: LiveCheckResult[] = await runLiveCheck(env, {
      fetch: rejecting.fetch,
    });
    expect(
      results.filter((result) => result.status === 'fail').length
    ).toBeGreaterThanOrEqual(3);
    expect(printLiveCheck(results)).toBe(1);
    const badVersion: LiveCheckResult[] = await runLiveCheck(
      { ...env, SHOPIFY_API_VERSION: 'latest' },
      { fetch: rejecting.fetch }
    );
    expect(
      badVersion.some(
        (result) => result.name === 'admin client' && result.status === 'fail'
      )
    ).toBe(true);
    expect(
      badVersion.some(
        (result) =>
          result.name === 'storefront client' && result.status === 'fail'
      )
    ).toBe(true);
  });
});

describe('live bulk mutation', () => {
  const env: Record<string, string> = {
    SHOPIFY_SHOP: 'example',
    SHOPIFY_API_VERSION: '2026-10',
    SHOPIFY_ADMIN_TOKEN: 'shpat_x',
    LIVE_ALLOW_WRITES: 'yes',
  };
  const names = (results: LiveCheckResult[]): string[][] =>
    results.map((result) => [result.name, result.status]);

  it('tags a product through a bulk mutation, verifies it, and cleans up', async () => {
    const fake: FakeShopify = fakeShopify({ productTags: ['existing'] });
    const results: LiveCheckResult[] = await runLiveBulkMutation(env, {
      fetch: fake.fetch,
    });
    expect(names(results)).toEqual([
      ['choose a product', 'pass'],
      ['bulk mutation: tagsAdd "bulk-test"', 'pass'],
      ['verify: the tag is on the product', 'pass'],
      ['cleanup: remove the tag', 'pass'],
    ]);
    expect(fake.uploads).toEqual([
      JSON.stringify({ id: 'gid://shopify/Product/1', tags: ['bulk-test'] }),
    ]);
    expect(fake.productTags).toEqual(['existing']);
    expect(printLiveCheck(results)).toBe(0);
  });

  it('can keep the tag and use a chosen product and tag', async () => {
    const fake: FakeShopify = fakeShopify();
    const results: LiveCheckResult[] = await runLiveBulkMutation(
      { ...env, LIVE_KEEP_TAG: 'yes', LIVE_TAG: 'custom' },
      { fetch: fake.fetch }
    );
    expect(results.at(-1)).toMatchObject({ name: 'cleanup', status: 'skip' });
    expect(fake.productTags).toEqual(['custom']);
    const chosen: LiveCheckResult[] = await runLiveBulkMutation(
      { ...env, LIVE_PRODUCT_ID: 'gid://shopify/Product/1', LIVE_TAG: 'other' },
      { fetch: fakeShopify().fetch }
    );
    expect(chosen[0]?.status).toBe('pass');
  });

  it('refuses to write without LIVE_ALLOW_WRITES=yes, and without a token', async () => {
    const fake: FakeShopify = fakeShopify();
    const refused: LiveCheckResult[] = await runLiveBulkMutation(
      { ...env, LIVE_ALLOW_WRITES: 'true' },
      { fetch: fake.fetch }
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]?.detail).toContain('LIVE_ALLOW_WRITES=yes');
    expect(fake.calls).toHaveLength(0);
    const unconfigured: LiveCheckResult[] = await runLiveBulkMutation({});
    expect(unconfigured[0]?.name).toBe('configuration');
    const badVersion: LiveCheckResult[] = await runLiveBulkMutation(
      { ...env, SHOPIFY_API_VERSION: 'latest' },
      { fetch: fake.fetch }
    );
    expect(badVersion[0]?.name).toBe('admin client');
  });

  it('stops before writing when the product already has the tag', async () => {
    const fake: FakeShopify = fakeShopify({ productTags: ['bulk-test'] });
    const results: LiveCheckResult[] = await runLiveBulkMutation(env, {
      fetch: fake.fetch,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('fail');
    expect(results[0]?.detail).toContain('already has the tag');
    expect(fake.uploads).toHaveLength(0);
  });

  it('fails when the tag does not arrive, and when Shopify rejects the token', async () => {
    const unapplied: FakeShopify = fakeShopify({ ignoreBulkMutation: true });
    const results: LiveCheckResult[] = await runLiveBulkMutation(env, {
      fetch: unapplied.fetch,
    });
    expect(
      results.find((result) => result.name.startsWith('verify'))
    ).toMatchObject({ status: 'fail' });
    const rejecting: FakeShopify = fakeShopify({ rejectAdmin: true });
    const rejected: LiveCheckResult[] = await runLiveBulkMutation(env, {
      fetch: rejecting.fetch,
    });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.status).toBe('fail');
  });
});

describe('dev server routes', () => {
  const call = (
    app: (request: Request) => Promise<Response>,
    path: string,
    init: RequestInit = {}
  ): Promise<Response> =>
    app(new Request(`https://app.example.com${path}`, init));

  it('installs a shop end to end and subscribes it to the webhooks', async () => {
    const { context, fake } = setup();
    const app: (request: Request) => Promise<Response> = createDevApp(context);

    const install: Response = await call(app, `/api/auth/install?shop=${shop}`);
    expect(install.status).toBe(302);
    const state: string =
      /shopify_oauth_state=([^;]+)/.exec(
        install.headers.get('set-cookie') ?? ''
      )?.[1] ?? '';
    expect(state).not.toBe('');

    const query: string = signedCallback({
      code: 'auth-code',
      shop,
      state,
      timestamp: String(Math.floor(Date.now() / 1000)),
    });
    const callback: Response = await call(app, `/api/auth/callback?${query}`, {
      headers: { cookie: `shopify_oauth_state=${state}` },
    });
    expect(callback.status).toBe(302);
    expect(fake.webhookSubscriptions.map((hook) => hook['topic'])).toEqual([
      'APP_UNINSTALLED',
      'PRODUCTS_UPDATE',
    ]);

    const home: Response = await call(app, `/?shop=${shop}`);
    const body: string = await home.text();
    expect(body).toContain(`Installed on ${shop}`);
    expect(body).not.toContain('shpat_');
  });

  it('answers sensibly to bad requests', async () => {
    const { context } = setup();
    const app: (request: Request) => Promise<Response> = createDevApp(context);
    expect((await call(app, '/')).status).toBe(200);
    expect((await call(app, '/?shop=nobody')).status).toBe(404);
    expect((await call(app, '/?shop=evil.example.com')).status).toBe(400);
    expect((await call(app, '/api/auth/install')).status).toBe(400);
    expect((await call(app, '/api/nothing')).status).toBe(404);
    expect(
      (await call(app, '/api/webhooks', { method: 'POST', body: '{}' })).status
    ).toBe(401);
  });
});
