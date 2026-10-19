import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  AuthenticationError,
  ConfigurationError,
  HttpError,
  NetworkError,
  ThrottledError,
  exchangeAuthorizationCode,
  exchangeIdToken,
  refreshAccessToken,
  type AccessTokenGrant,
  type Result,
  type ShopifyError,
} from '../src/index.js';
import { jsonResponse } from './helpers.js';

const credentials: { clientId: string; clientSecret: string } = {
  clientId: 'client-1',
  clientSecret: 'super-secret-value',
};
const fixedNow: number = 1_760_000_000_000;

type GrantResult = Result<AccessTokenGrant>;

function makeFetch(): Mock<typeof fetch> {
  return vi.fn<typeof fetch>();
}

function options(fetchMock: Mock<typeof fetch>): {
  fetch: typeof fetch;
  now: () => number;
} {
  return { fetch: fetchMock, now: (): number => fixedNow };
}

function sentForm(fetchMock: Mock<typeof fetch>): URLSearchParams {
  const init: RequestInit | undefined = fetchMock.mock.calls[0]?.[1];
  return new URLSearchParams(init?.body as string);
}

function failure(result: GrantResult): ShopifyError {
  if (result.ok) throw new Error('Expected an Err result.');
  expect(result.error.message).not.toContain(credentials.clientSecret);
  return result.error;
}

describe('exchangeAuthorizationCode', () => {
  it('posts the form to the shop token endpoint and parses an expiring grant', async () => {
    const fetchMock: Mock<typeof fetch> = makeFetch();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        access_token: 'shpat_abc',
        scope: 'read_products,write_orders',
        expires_in: 3600,
        refresh_token: 'shprt_xyz',
        refresh_token_expires_in: 7_776_000,
      })
    );

    const result: GrantResult = await exchangeAuthorizationCode(
      { ...credentials, shop: 'example', code: 'code-1' },
      options(fetchMock)
    );

    expect(result).toEqual({
      ok: true,
      value: {
        accessToken: 'shpat_abc',
        scope: ['read_products', 'write_orders'],
        expiresAt: fixedNow + 3_600_000,
        refreshToken: 'shprt_xyz',
        refreshTokenExpiresAt: fixedNow + 7_776_000_000,
        associatedUser: undefined,
        associatedUserScope: undefined,
      },
    });
    const [url, init]: Parameters<typeof fetch> = fetchMock.mock
      .calls[0] as Parameters<typeof fetch>;
    expect(url).toBe('https://example.myshopify.com/admin/oauth/access_token');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(Object.fromEntries(sentForm(fetchMock))).toEqual({
      client_id: 'client-1',
      client_secret: 'super-secret-value',
      code: 'code-1',
      expiring: '1',
    });
  });

  it('can ask for a non-expiring token', async () => {
    const fetchMock: Mock<typeof fetch> = makeFetch();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: 'shpat_abc', scope: 'read_products' })
    );
    const result: GrantResult = await exchangeAuthorizationCode(
      { ...credentials, shop: 'example', code: 'c', expiring: false },
      options(fetchMock)
    );
    expect(sentForm(fetchMock).get('expiring')).toBe('0');
    expect(result.ok && result.value.expiresAt).toBeUndefined();
    expect(result.ok && result.value.refreshToken).toBeUndefined();
    expect(result.ok && result.value.refreshTokenExpiresAt).toBeUndefined();
  });

  it.each([
    [{ shop: 'evil.com' }, 'myshopify.com'],
    [{ clientId: '' }, 'clientId'],
    [{ clientSecret: ' ' }, 'clientSecret'],
    [{ code: '' }, 'code'],
  ])(
    'refuses a bad %s without calling Shopify',
    async (override: object, expected: string) => {
      const fetchMock: Mock<typeof fetch> = makeFetch();
      const error: ShopifyError = failure(
        await exchangeAuthorizationCode(
          { ...credentials, shop: 'example', code: 'c', ...override },
          options(fetchMock)
        )
      );
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(error.message).toContain(expected);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
});

describe('exchangeIdToken', () => {
  it('requests an offline expiring token by default', async () => {
    const fetchMock: Mock<typeof fetch> = makeFetch();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: 'shpat_off', scope: 'read_products' })
    );
    await exchangeIdToken(
      { ...credentials, shop: 'example', idToken: 'jwt' },
      options(fetchMock)
    );
    expect(Object.fromEntries(sentForm(fetchMock))).toEqual({
      client_id: 'client-1',
      client_secret: 'super-secret-value',
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'jwt',
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      requested_token_type:
        'urn:shopify:params:oauth:token-type:offline-access-token',
      expiring: '1',
    });
  });

  it('requests an online token and parses the associated user', async () => {
    const fetchMock: Mock<typeof fetch> = makeFetch();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        access_token: 'shpat_on',
        scope: 'read_products,write_orders',
        expires_in: 86_399,
        associated_user_scope: 'read_products',
        associated_user: {
          id: 902_541_635,
          first_name: 'Ada',
          last_name: 'Lovelace',
          email: 'ada@example.com',
          email_verified: true,
          account_owner: true,
          locale: 'en',
          collaborator: false,
        },
      })
    );
    const result: GrantResult = await exchangeIdToken(
      { ...credentials, shop: 'example', idToken: 'jwt', tokenType: 'online' },
      options(fetchMock)
    );
    const form: URLSearchParams = sentForm(fetchMock);
    expect(form.get('requested_token_type')).toBe(
      'urn:shopify:params:oauth:token-type:online-access-token'
    );
    expect(form.has('expiring')).toBe(false);
    expect(result.ok && result.value.associatedUser).toEqual({
      id: 902_541_635,
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      emailVerified: true,
      accountOwner: true,
      locale: 'en',
      collaborator: false,
    });
    expect(result.ok && result.value.associatedUserScope).toEqual([
      'read_products',
    ]);
  });

  it('can ask for a non-expiring offline token', async () => {
    const fetchMock: Mock<typeof fetch> = makeFetch();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: 'shpat_off', scope: '' })
    );
    const result: GrantResult = await exchangeIdToken(
      { ...credentials, shop: 'example', idToken: 'jwt', expiring: false },
      options(fetchMock)
    );
    expect(sentForm(fetchMock).get('expiring')).toBe('0');
    expect(result.ok && result.value.scope).toEqual([]);
  });

  it('ignores an incomplete associated_user', async () => {
    const fetchMock: Mock<typeof fetch> = makeFetch();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: 't', associated_user: { first_name: 'x' } })
    );
    const result: GrantResult = await exchangeIdToken(
      { ...credentials, shop: 'example', idToken: 'jwt' },
      options(fetchMock)
    );
    expect(result.ok && result.value.associatedUser).toBeUndefined();
  });

  it('refuses an empty ID token', async () => {
    const fetchMock: Mock<typeof fetch> = makeFetch();
    const error: ShopifyError = failure(
      await exchangeIdToken(
        { ...credentials, shop: 'example', idToken: ' ' },
        options(fetchMock)
      )
    );
    expect(error.message).toContain('idToken');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tells the caller a 400 usually means a stale ID token', async () => {
    const fetchMock: Mock<typeof fetch> = makeFetch();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'invalid_subject_token' }, { status: 400 })
    );
    const error: ShopifyError = failure(
      await exchangeIdToken(
        { ...credentials, shop: 'example', idToken: 'jwt' },
        options(fetchMock)
      )
    );
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.message).toContain('invalid_subject_token');
    expect(error.message).toContain('fresh one');
    expect(error.context.status).toBe(400);
  });
});

describe('refreshAccessToken', () => {
  it('sends the refresh_token grant', async () => {
    const fetchMock: Mock<typeof fetch> = makeFetch();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          access_token: 'shpat_new',
          expires_in: 3600,
          refresh_token: 'shprt_new',
          refresh_token_expires_in: 7_776_000,
          scope: 'write_products,read_orders',
        },
        { headers: { 'x-request-id': 'req-1' } }
      )
    );
    const result: GrantResult = await refreshAccessToken(
      { ...credentials, shop: 'example', refreshToken: 'shprt_old' },
      options(fetchMock)
    );
    expect(Object.fromEntries(sentForm(fetchMock))).toEqual({
      client_id: 'client-1',
      client_secret: 'super-secret-value',
      grant_type: 'refresh_token',
      refresh_token: 'shprt_old',
    });
    expect(result.ok && result.value.refreshToken).toBe('shprt_new');
  });

  it('refuses an empty refresh token', async () => {
    const error: ShopifyError = failure(
      await refreshAccessToken(
        { ...credentials, shop: 'example', refreshToken: '' },
        options(makeFetch())
      )
    );
    expect(error.message).toContain('refreshToken');
  });
});

describe('token endpoint failures', () => {
  async function exchange(response: Response | Error): Promise<ShopifyError> {
    const fetchMock: Mock<typeof fetch> = makeFetch();
    if (response instanceof Error) fetchMock.mockRejectedValueOnce(response);
    else fetchMock.mockResolvedValueOnce(response);
    return failure(
      await exchangeAuthorizationCode(
        { ...credentials, shop: 'example', code: 'c' },
        options(fetchMock)
      )
    );
  }

  it('maps 401 and 403 to bad credentials', async () => {
    for (const status of [401, 403]) {
      const error: ShopifyError = await exchange(
        new Response('nope', { status })
      );
      expect(error).toBeInstanceOf(AuthenticationError);
      expect(error.message).toContain('clientSecret');
    }
  });

  it('maps 429 to ThrottledError with Retry-After', async () => {
    const error: ShopifyError = await exchange(
      new Response('', { status: 429, headers: { 'retry-after': '4' } })
    );
    expect(error).toBeInstanceOf(ThrottledError);
    expect((error as ThrottledError).retryAfterMs).toBe(4000);
    expect(await exchange(new Response('', { status: 429 }))).toBeInstanceOf(
      ThrottledError
    );
  });

  it('maps other statuses to HttpError', async () => {
    const error: ShopifyError = await exchange(
      new Response('oops', { status: 503 })
    );
    expect(error).toBeInstanceOf(HttpError);
    expect(error.context.status).toBe(503);
    expect(
      (await exchange(new Response('', { status: 500 }))).message
    ).not.toContain('""');
  });

  it('reports invalid JSON and a missing access_token', async () => {
    expect(
      (await exchange(new Response('<html>', { status: 200 }))).message
    ).toContain('not valid JSON');
    expect((await exchange(jsonResponse({ scope: 'x' }))).message).toContain(
      'no access_token'
    );
  });

  it('reports network failures', async () => {
    const error: ShopifyError = await exchange(new TypeError('fetch failed'));
    expect(error).toBeInstanceOf(NetworkError);
    expect(error.message).toContain('fetch failed');
  });

  it('reports a failure while reading the body', async () => {
    const broken: Response = new Response('x', { status: 200 });
    vi.spyOn(broken, 'text').mockRejectedValue(new Error('socket closed'));
    expect((await exchange(broken)).message).toContain(
      'reading the response body'
    );
  });
});
