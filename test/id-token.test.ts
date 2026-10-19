import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  AuthenticationError,
  validateIdToken,
  type IdTokenClaims,
  type Result,
} from '../src/index.js';
import { omit } from './helpers.js';

const clientId: string = 'client-id-123';
const clientSecret: string = 'client-secret';
const nowSeconds: number = 1_760_000_000;

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function sign(
  payload: Record<string, unknown>,
  options: { secret?: string; header?: Record<string, unknown> } = {}
): string {
  const head: string = encode(options.header ?? { alg: 'HS256', typ: 'JWT' });
  const body: string = encode(payload);
  const signature: string = createHmac('sha256', options.secret ?? clientSecret)
    .update(`${head}.${body}`)
    .digest('base64url');
  return `${head}.${body}.${signature}`;
}

const goodPayload: Record<string, unknown> = {
  iss: 'https://example.myshopify.com/admin',
  dest: 'https://example.myshopify.com',
  aud: clientId,
  sub: '42',
  sid: 'session-1',
  jti: 'jti-1',
  exp: nowSeconds + 50,
  nbf: nowSeconds - 10,
  iat: nowSeconds - 10,
};

function check(
  token: string,
  clockToleranceSeconds?: number
): Promise<Result<IdTokenClaims, AuthenticationError>> {
  return validateIdToken(token, {
    clientId,
    clientSecret,
    now: (): number => nowSeconds * 1000,
    ...(clockToleranceSeconds === undefined ? {} : { clockToleranceSeconds }),
  });
}

async function rejection(token: string, tolerance?: number): Promise<string> {
  const result: Result<IdTokenClaims, AuthenticationError> = await check(
    token,
    tolerance
  );
  if (result.ok) throw new Error('Expected the token to be rejected.');
  expect(result.error).toBeInstanceOf(AuthenticationError);
  expect(result.error.message).toContain('401');
  return result.error.message;
}

describe('validateIdToken', () => {
  it('returns normalized claims for a valid token', async () => {
    const result: Result<IdTokenClaims, AuthenticationError> = await check(
      sign(goodPayload)
    );
    expect(result).toEqual({
      ok: true,
      value: {
        shop: 'example.myshopify.com',
        sub: '42',
        sid: 'session-1',
        jti: 'jti-1',
        iss: 'https://example.myshopify.com/admin',
        dest: 'https://example.myshopify.com',
        aud: clientId,
        exp: nowSeconds + 50,
        nbf: nowSeconds - 10,
        iat: nowSeconds - 10,
      },
    });
  });

  it('tolerates missing optional claims', async () => {
    const minimal: Record<string, unknown> = omit(
      omit(omit(omit(goodPayload, 'sub'), 'sid'), 'jti'),
      'iat'
    );
    const result: Result<IdTokenClaims, AuthenticationError> = await check(
      sign(minimal)
    );
    expect(result.ok && result.value.sub).toBeUndefined();
  });

  it('works with the real clock', async () => {
    const now: number = Math.floor(Date.now() / 1000);
    const result: Result<IdTokenClaims, AuthenticationError> =
      await validateIdToken(
        sign({ ...goodPayload, exp: now + 60, nbf: now - 5 }),
        { clientId, clientSecret }
      );
    expect(result.ok).toBe(true);
  });

  it('rejects tokens that are not three-part JWTs', async () => {
    expect(await rejection('abc')).toContain('three-part');
    expect(await rejection('a.b.c.d')).toContain('three-part');
  });

  it('rejects an unreadable header and any algorithm other than HS256', async () => {
    expect(await rejection('!!.e30.sig')).toContain('header');
    expect(
      await rejection(sign(goodPayload, { header: { alg: 'none' } }))
    ).toContain('HS256');
    expect(
      await rejection(sign(goodPayload, { header: { alg: 'HS512' } }))
    ).toContain('HS256');
    expect(
      await rejection(`${encode({ alg: 'none' })}.${encode(goodPayload)}.`)
    ).toContain('HS256');
  });

  it('rejects a wrong secret, tampered payload or malformed signature', async () => {
    expect(await rejection(sign(goodPayload, { secret: 'other' }))).toContain(
      'signature'
    );
    const [head, , signature] = sign(goodPayload).split('.');
    const tampered: string = `${head ?? ''}.${encode({ ...goodPayload, dest: 'https://evil.myshopify.com' })}.${signature ?? ''}`;
    expect(await rejection(tampered)).toContain('signature');
    expect(
      await rejection(`${head ?? ''}.${encode(goodPayload)}.***`)
    ).toContain('signature');
  });

  it('rejects an unreadable payload', async () => {
    const head: string = encode({ alg: 'HS256' });
    const body: string = Buffer.from('not json').toString('base64url');
    const signature: string = createHmac('sha256', clientSecret)
      .update(`${head}.${body}`)
      .digest('base64url');
    expect(await rejection(`${head}.${body}.${signature}`)).toContain(
      'payload'
    );
  });

  it('rejects expired tokens, honoring the clock tolerance', async () => {
    const expired: string = sign({ ...goodPayload, exp: nowSeconds - 11 });
    expect(await rejection(expired)).toContain('expired');
    expect(
      (await check(sign({ ...goodPayload, exp: nowSeconds - 5 }))).ok
    ).toBe(true);
    expect(
      await rejection(sign({ ...goodPayload, exp: nowSeconds - 5 }), 0)
    ).toContain('expired');
    const withoutExp: Record<string, unknown> = omit(goodPayload, 'exp');
    expect(await rejection(sign(withoutExp))).toContain('"exp"');
  });

  it('rejects tokens that are not valid yet', async () => {
    expect(
      await rejection(sign({ ...goodPayload, nbf: nowSeconds + 60 }))
    ).toContain('"nbf"');
    const withoutNbf: Record<string, unknown> = omit(goodPayload, 'nbf');
    expect(await rejection(sign(withoutNbf))).toContain('"nbf"');
  });

  it('rejects a token issued for another app', async () => {
    expect(
      await rejection(sign({ ...goodPayload, aud: 'someone-else' }))
    ).toContain('"aud"');
  });

  it('rejects mismatched or missing iss and dest hosts', async () => {
    expect(
      await rejection(
        sign({ ...goodPayload, iss: 'https://other.myshopify.com/admin' })
      )
    ).toContain('"iss"');
    expect(
      await rejection(sign({ ...goodPayload, dest: 'nonsense' }))
    ).toContain('"iss"');
    const withoutIss: Record<string, unknown> = omit(goodPayload, 'iss');
    expect(await rejection(sign(withoutIss))).toContain('"iss"');
  });

  it('rejects a destination outside myshopify.com', async () => {
    expect(
      await rejection(
        sign({
          ...goodPayload,
          iss: 'https://evil.example.com/admin',
          dest: 'https://evil.example.com',
        })
      )
    ).toContain('.myshopify.com');
  });
});
