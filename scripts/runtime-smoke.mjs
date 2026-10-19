/**
 * Runtime smoke checks. Uses only Web-standard APIs (no node: imports, no test
 * framework) so the same file runs under Node, Bun, Deno, edge VMs and
 * Workers. Signatures are produced here with Web Crypto, independently of the
 * library, so a pass means the library agrees with the platform.
 */

const encoder = new TextEncoder();

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(text))
  );
}

const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
const toBase64Url = (bytes) =>
  toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const toHex = (bytes) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const textToBase64Url = (text) => toBase64Url(encoder.encode(text));

const jsonResponse = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

/** Runs every check against `lib` (the package's exports) and returns the outcomes. */
export async function smoke(lib) {
  const results = [];
  const check = async (name, body) => {
    try {
      await body();
      results.push({ name, ok: true });
    } catch (thrown) {
      results.push({
        name,
        ok: false,
        detail: thrown instanceof Error ? thrown.message : String(thrown),
      });
    }
  };
  const expect = (condition, message) => {
    if (!condition) throw new Error(message);
  };

  await check(
    'webhook: valid signature accepted, tampered body rejected',
    async () => {
      const body = JSON.stringify({ id: 1, title: 'Ünïcode ✓' });
      const headers = {
        'X-Shopify-Hmac-Sha256': toBase64(await hmac('secret', body)),
        'X-Shopify-Topic': 'products/update',
        'X-Shopify-Shop-Domain': 'example.myshopify.com',
        'X-Shopify-Webhook-Id': 'w1',
      };
      const good = await lib.verifyWebhook(
        { rawBody: body, headers: new Headers(headers) },
        'secret'
      );
      expect(
        good.ok && good.value.payload.id === 1,
        'valid webhook was rejected'
      );
      const bad = await lib.verifyWebhook(
        { rawBody: body + ' ', headers },
        'secret'
      );
      expect(!bad.ok, 'tampered webhook was accepted');
    }
  );

  await check('id token: valid accepted, expired rejected', async () => {
    const now = Math.floor(Date.now() / 1000);
    const sign = async (claims) => {
      const head = textToBase64Url(
        JSON.stringify({ alg: 'HS256', typ: 'JWT' })
      );
      const payload = textToBase64Url(JSON.stringify(claims));
      return `${head}.${payload}.${toBase64Url(await hmac('secret', `${head}.${payload}`))}`;
    };
    const claims = {
      iss: 'https://example.myshopify.com/admin',
      dest: 'https://example.myshopify.com',
      aud: 'client',
      exp: now + 60,
      nbf: now - 5,
    };
    const good = await lib.validateIdToken(await sign(claims), {
      clientId: 'client',
      clientSecret: 'secret',
    });
    expect(
      good.ok && good.value.shop === 'example.myshopify.com',
      'valid token was rejected'
    );
    const expired = await lib.validateIdToken(
      await sign({ ...claims, exp: now - 600 }),
      {
        clientId: 'client',
        clientSecret: 'secret',
      }
    );
    expect(!expired.ok, 'expired token was accepted');
  });

  await check('oauth callback: signature and state verified', async () => {
    const fields = [
      ['code', 'abc'],
      ['shop', 'example.myshopify.com'],
      ['state', 'state-1234567890'],
      ['timestamp', String(Math.floor(Date.now() / 1000))],
    ];
    const signed = toHex(
      await hmac('secret', new URLSearchParams(fields).toString())
    );
    const query = new URLSearchParams([...fields, ['hmac', signed]]);
    const good = await lib.validateOAuthCallback({
      query,
      clientSecret: 'secret',
      expectedState: 'state-1234567890',
    });
    expect(good.ok && good.value.code === 'abc', 'valid callback was rejected');
    const wrongState = await lib.validateOAuthCallback({
      query,
      clientSecret: 'secret',
      expectedState: 'other-state-0000',
    });
    expect(!wrongState.ok, 'callback with the wrong state was accepted');
  });

  await check('admin client: data, auth failure and retry on 502', async () => {
    let calls = 0;
    const fakeFetch = async (url, init) => {
      calls += 1;
      expect(
        String(url) ===
          'https://example.myshopify.com/admin/api/2026-10/graphql.json',
        `unexpected URL ${url}`
      );
      expect(
        new Headers(init.headers).get('x-shopify-access-token') === 'token',
        'access token header missing'
      );
      if (calls === 1) return new Response('', { status: 502 });
      return jsonResponse({ data: { shop: { name: 'Example' } } });
    };
    const created = lib.createAdminClient({
      shop: 'example',
      accessToken: 'token',
      apiVersion: '2026-10',
      fetch: fakeFetch,
      sleep: async () => undefined,
    });
    expect(created.ok, 'client was not created');
    const result = await created.value.request('{ shop { name } }');
    expect(
      result.ok &&
        result.value.data.shop.name === 'Example' &&
        result.value.attempts === 2,
      'request did not retry and succeed'
    );
    const denied = lib.createAdminClient({
      shop: 'example',
      accessToken: 'token',
      apiVersion: '2026-10',
      fetch: async () => new Response('no', { status: 401 }),
    });
    const failure = await denied.value.request('{ a }');
    expect(
      !failure.ok && failure.error.code === 'AUTHENTICATION',
      '401 was not mapped to AuthenticationError'
    );
  });

  await check('pagination: walks two pages', async () => {
    const pages = [
      { nodes: [1, 2], pageInfo: { hasNextPage: true, endCursor: 'c1' } },
      { nodes: [3], pageInfo: { hasNextPage: false, endCursor: 'c2' } },
    ];
    let index = 0;
    const created = lib.createAdminClient({
      shop: 'example',
      accessToken: 'token',
      apiVersion: '2026-10',
      fetch: async () => jsonResponse({ data: { items: pages[index++] } }),
    });
    const all = await lib.collectNodes(
      created.value,
      'query($after: String) { items(after: $after) { nodes } }',
      {
        select: (data) => data.items,
      }
    );
    expect(
      all.ok && all.value.join() === '1,2,3',
      'pagination did not collect all nodes'
    );
  });

  await check(
    'bulk results: streams chunked JSONL with split characters',
    async () => {
      const bytes = encoder.encode(
        '{"id":"1","t":"é"}\n{"id":"2","__parentId":"1"}\n'
      );
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, 9));
          controller.enqueue(bytes.slice(9));
          controller.close();
        },
      });
      const rows = [];
      for await (const row of lib.streamBulkResults(
        'https://storage.example.com/r.jsonl',
        {
          fetch: async () => new Response(body),
        }
      )) {
        expect(row.ok, 'a row failed to parse');
        rows.push(row.value);
      }
      expect(
        rows.length === 2 && rows[0].t === 'é' && rows[1].__parentId === '1',
        'rows were not read correctly'
      );
    }
  );

  await check('storefront client: private token header', async () => {
    let seen;
    const created = lib.createStorefrontClient({
      shop: 'example',
      apiVersion: '2026-10',
      privateAccessToken: 'private',
      fetch: async (url, init) => {
        seen = new Headers(init.headers);
        return jsonResponse({ data: {} });
      },
    });
    await created.value.request('{ shop { name } }', {
      buyerIp: '203.0.113.7',
    });
    expect(
      seen.get('shopify-storefront-private-token') === 'private',
      'private token header missing'
    );
    expect(
      seen.get('shopify-storefront-buyer-ip') === '203.0.113.7',
      'buyer IP header missing'
    );
  });

  await check('sessions: memory storage round trip', async () => {
    const storage = lib.createMemorySessionStorage();
    const session = lib.sessionFromGrant('example.myshopify.com', {
      accessToken: 'shpat_x',
      scope: ['read_products'],
      expiresAt: undefined,
      refreshToken: undefined,
      refreshTokenExpiresAt: undefined,
      associatedUser: undefined,
      associatedUserScope: undefined,
    });
    await storage.store(session);
    const loaded = await storage.load(session.id);
    expect(
      loaded.ok && loaded.value?.accessToken === 'shpat_x',
      'session was not stored'
    );
  });

  return results;
}

/** Prints results and returns the process exit code. */
export function report(label, results) {
  let failed = 0;
  for (const result of results) {
    if (!result.ok) failed += 1;
    console.log(
      `${result.ok ? 'PASS' : 'FAIL'}  [${label}] ${result.name}${result.ok ? '' : ` -- ${result.detail}`}`
    );
  }
  console.log(`${label}: ${results.length - failed}/${results.length} passed`);
  return failed === 0 ? 0 : 1;
}
