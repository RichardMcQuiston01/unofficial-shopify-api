import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  base64ToBytes,
  constantTimeEqual,
  base64UrlToText,
  hexToBytes,
  hmacSha256,
  randomHex,
  verifyHmac,
} from '../src/auth/crypto.js';

describe('hmacSha256', () => {
  it('matches Node crypto for strings and bytes', async () => {
    const expected: Buffer = createHmac('sha256', 'secret')
      .update('hello')
      .digest();
    expect(Buffer.from(await hmacSha256('secret', 'hello'))).toEqual(expected);
    expect(
      Buffer.from(await hmacSha256('secret', new TextEncoder().encode('hello')))
    ).toEqual(expected);
  });
});

describe('verifyHmac', () => {
  it('accepts the right signature and rejects others', async () => {
    const good: Uint8Array = new Uint8Array(
      createHmac('sha256', 'secret').update('hello').digest()
    );
    expect(await verifyHmac('secret', 'hello', good)).toBe(true);
    expect(await verifyHmac('other-secret', 'hello', good)).toBe(false);
    expect(await verifyHmac('secret', 'hellO', good)).toBe(false);
    expect(await verifyHmac('secret', 'hello', good.slice(0, 31))).toBe(false);
    expect(
      await verifyHmac('secret', new TextEncoder().encode('hello'), good)
    ).toBe(true);
  });
});

describe('constantTimeEqual', () => {
  it('compares strings of any length', async () => {
    expect(await constantTimeEqual('same', 'same')).toBe(true);
    expect(await constantTimeEqual('same', 'sama')).toBe(false);
    expect(await constantTimeEqual('same', 'same-but-longer')).toBe(false);
    expect(await constantTimeEqual('', '')).toBe(true);
  });
});

describe('hexToBytes', () => {
  it('decodes valid hex in either case', () => {
    expect(hexToBytes('00ffA1')).toEqual(new Uint8Array([0, 255, 161]));
  });

  it.each(['', 'abc', 'zz', '0x12'])('rejects %j', (input: string) => {
    expect(hexToBytes(input)).toBeUndefined();
  });
});

describe('base64ToBytes', () => {
  it('decodes standard, URL-safe, padded and unpadded input', () => {
    const expected: Uint8Array = new Uint8Array([251, 255, 190]);
    expect(base64ToBytes('+/++')).toEqual(expected);
    expect(base64ToBytes('-_--')).toEqual(expected);
    expect(base64ToBytes('aGk=')).toEqual(new Uint8Array([104, 105]));
    expect(base64ToBytes('aGk')).toEqual(new Uint8Array([104, 105]));
  });

  it('rejects characters outside the alphabet and impossible lengths', () => {
    expect(base64ToBytes('a b')).toBeUndefined();
    expect(base64ToBytes('a')).toBeUndefined();
  });
});

describe('base64UrlToText', () => {
  it('decodes UTF-8 and rejects invalid UTF-8', () => {
    expect(base64UrlToText(Buffer.from('héllo').toString('base64url'))).toBe(
      'héllo'
    );
    expect(
      base64UrlToText(Buffer.from([0xff, 0xfe]).toString('base64url'))
    ).toBeUndefined();
    expect(base64UrlToText('!!')).toBeUndefined();
  });
});

describe('randomHex', () => {
  it('returns the requested number of random bytes as hex', () => {
    const first: string = randomHex(16);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(randomHex(16)).not.toBe(first);
    expect(randomHex()).toHaveLength(32);
  });
});
