import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  AuthenticationError,
  buildAuthorizationUrl,
  generateState,
  validateOAuthCallback,
  type CallbackValidationParams,
  type Result,
  type ValidatedCallback,
} from '../src/index.js';
import { omit } from './helpers.js';

const clientSecret: string = 'hush';
const state: string = 'abcdef0123456789';
const nowSeconds: number = 1_760_000_000;

/** Signs the way Shopify does, independently of the library under test. */
function signedQuery(
  fields: Record<string, string>,
  secret: string = clientSecret
): URLSearchParams {
  const entries: [string, string][] = Object.entries(fields).sort(
    ([left]: [string, string], [right]: [string, string]): number =>
      left < right ? -1 : 1
  );
  const hmac: string = createHmac('sha256', secret)
    .update(new URLSearchParams(entries).toString())
    .digest('hex');
  return new URLSearchParams([...entries, ['hmac', hmac]]);
}

const goodFields: Record<string, string> = {
  code: 'auth-code-123',
  host: 'YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvZXhhbXBsZQ',
  shop: 'example.myshopify.com',
  state,
  timestamp: String(nowSeconds),
};

function validate(
  query: CallbackValidationParams['query'],
  extra: Partial<CallbackValidationParams> = {}
): Promise<Result<ValidatedCallback, AuthenticationError>> {
  return validateOAuthCallback({
    query,
    clientSecret,
    expectedState: state,
    now: (): number => nowSeconds * 1000,
    ...extra,
  });
}

function failureMessage(result: Result<unknown, Error>): string {
  if (result.ok) throw new Error('Expected an Err result.');
  expect(result.error).toBeInstanceOf(AuthenticationError);
  return result.error.message;
}

describe('buildAuthorizationUrl', () => {
  const params: Parameters<typeof buildAuthorizationUrl>[0] = {
    shop: 'example',
    clientId: 'client-1',
    scopes: ['read_products', 'write_orders'],
    redirectUri: 'https://app.example.com/auth/callback',
    state,
  };

  it('builds the authorize URL', () => {
    const result: Result<string, Error> = buildAuthorizationUrl(params);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const url: URL = new URL(result.value);
    expect(url.origin + url.pathname).toBe(
      'https://example.myshopify.com/admin/oauth/authorize'
    );
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('scope')).toBe('read_products,write_orders');
    expect(url.searchParams.get('redirect_uri')).toBe(params.redirectUri);
    expect(url.searchParams.get('state')).toBe(state);
    expect(url.searchParams.has('grant_options[]')).toBe(false);
  });

  it('requests an online token with perUser', () => {
    const result: Result<string, Error> = buildAuthorizationUrl({
      ...params,
      perUser: true,
    });
    expect(
      result.ok && new URL(result.value).searchParams.get('grant_options[]')
    ).toBe('per-user');
  });

  it('allows http redirects only for localhost', () => {
    expect(
      buildAuthorizationUrl({
        ...params,
        redirectUri: 'http://localhost:3000/cb',
      }).ok
    ).toBe(true);
    const remote: Result<string, Error> = buildAuthorizationUrl({
      ...params,
      redirectUri: 'http://app.example.com/cb',
    });
    expect(remote.ok).toBe(false);
  });

  it.each([
    [{ shop: 'evil.com' }, 'myshopify.com'],
    [{ clientId: ' ' }, 'clientId'],
    [{ scopes: [] }, 'scopes'],
    [{ state: 'abc' }, 'generateState'],
    [{ redirectUri: 'not a url' }, 'not a valid absolute URL'],
  ])('refuses a bad %s', (override: object, expected: string) => {
    const result: Result<string, Error> = buildAuthorizationUrl({
      ...params,
      ...override,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain(expected);
  });
});

describe('generateState', () => {
  it('returns a different 32-character value each time', () => {
    const first: string = generateState();
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(generateState()).not.toBe(first);
  });
});

describe('validateOAuthCallback', () => {
  it('accepts a correctly signed callback in every input shape', async () => {
    const query: URLSearchParams = signedQuery(goodFields);
    const expected: ValidatedCallback = {
      shop: 'example.myshopify.com',
      code: 'auth-code-123',
      host: goodFields['host'],
    };
    for (const input of [
      query,
      query.toString(),
      `?${query.toString()}`,
      Object.fromEntries(query.entries()),
    ]) {
      const result: Result<ValidatedCallback, AuthenticationError> =
        await validate(input, { maxTimestampAgeSeconds: 300 });
      expect(result).toEqual({ ok: true, value: expected });
    }
  });

  it('reports host as undefined when Shopify sent none', async () => {
    const withoutHost: Record<string, string> = omit(goodFields, 'host');
    const result: Result<ValidatedCallback, AuthenticationError> =
      await validate(signedQuery(withoutHost));
    expect(result.ok && result.value.host).toBeUndefined();
  });

  it('rejects a missing, repeated or malformed hmac', async () => {
    expect(
      failureMessage(await validate(new URLSearchParams(goodFields)))
    ).toContain('"hmac" parameter is missing');
    const repeated: URLSearchParams = signedQuery(goodFields);
    repeated.append('hmac', 'abcd');
    expect(failureMessage(await validate(repeated))).toContain(
      'more than once'
    );
    const malformed: URLSearchParams = signedQuery(goodFields);
    malformed.set('hmac', 'not-hex');
    expect(failureMessage(await validate(malformed))).toContain(
      'does not match'
    );
  });

  it('rejects a tampered parameter, an added parameter and the wrong secret', async () => {
    const tampered: URLSearchParams = signedQuery(goodFields);
    tampered.set('code', 'stolen');
    expect(failureMessage(await validate(tampered))).toContain(
      'does not match'
    );
    const added: URLSearchParams = signedQuery(goodFields);
    added.set('extra', '1');
    expect(failureMessage(await validate(added))).toContain('does not match');
    expect(
      failureMessage(await validate(signedQuery(goodFields, 'other-secret')))
    ).toContain('does not match');
  });

  it('rejects a state that is missing, wrong or empty', async () => {
    expect(
      failureMessage(
        await validate(
          signedQuery({ ...goodFields, state: 'forged-state-000' })
        )
      )
    ).toContain('"state"');
    const withoutState: Record<string, string> = omit(goodFields, 'state');
    expect(failureMessage(await validate(signedQuery(withoutState)))).toContain(
      '"state"'
    );
    expect(
      failureMessage(
        await validate(signedQuery({ ...goodFields, state: '' }), {
          expectedState: '',
        })
      )
    ).toContain('"state"');
  });

  it('rejects a correctly signed callback for a non-Shopify host', async () => {
    const message: string = failureMessage(
      await validate(signedQuery({ ...goodFields, shop: 'evil.example.com' }))
    );
    expect(message).toContain('"shop"');
  });

  it('checks timestamp age only when asked', async () => {
    const stale: URLSearchParams = signedQuery({
      ...goodFields,
      timestamp: String(nowSeconds - 3600),
    });
    expect((await validate(stale)).ok).toBe(true);
    expect(
      failureMessage(await validate(stale, { maxTimestampAgeSeconds: 300 }))
    ).toContain('"timestamp"');
    const withoutTimestamp: Record<string, string> = omit(
      goodFields,
      'timestamp'
    );
    expect(
      failureMessage(
        await validate(signedQuery(withoutTimestamp), {
          maxTimestampAgeSeconds: 300,
        })
      )
    ).toContain('"timestamp"');
  });

  it('rejects a callback without a code', async () => {
    const withoutCode: Record<string, string> = omit(goodFields, 'code');
    expect(failureMessage(await validate(signedQuery(withoutCode)))).toContain(
      '"code"'
    );
  });

  it('uses the real clock when none is given', async () => {
    const fresh: URLSearchParams = signedQuery({
      ...goodFields,
      timestamp: String(Math.floor(Date.now() / 1000)),
    });
    const result: Result<ValidatedCallback, AuthenticationError> =
      await validateOAuthCallback({
        query: fresh,
        clientSecret,
        expectedState: state,
        maxTimestampAgeSeconds: 300,
      });
    expect(result.ok).toBe(true);
  });
});
