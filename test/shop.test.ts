import { describe, expect, it } from 'vitest';

import {
  createAdminClient,
  type AdminClient,
  type ConfigurationError,
  type Result,
} from '../src/index.js';
import { normalizeShopDomain, validateApiVersion } from '../src/client/shop.js';

describe('normalizeShopDomain', () => {
  it.each([
    ['example', 'example.myshopify.com'],
    ['Example.myshopify.com', 'example.myshopify.com'],
    ['https://example.myshopify.com/', 'example.myshopify.com'],
    [
      '  https://example.myshopify.com/admin/products  ',
      'example.myshopify.com',
    ],
  ])('normalizes %s', (input: string, expected: string) => {
    expect(normalizeShopDomain(input)).toEqual({ ok: true, value: expected });
  });

  it.each([
    'evil.com',
    'example.myshopify.com.evil.com',
    'http://example.myshopify.com',
    '',
    '-bad.myshopify.com',
    'exa mple',
  ])('refuses %j so a token cannot go to another host', (input: string) => {
    const result: Result<string, ConfigurationError> =
      normalizeShopDomain(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CONFIGURATION');
      expect(result.error.message).toContain('myshopify.com');
    }
  });
});

describe('validateApiVersion', () => {
  it.each(['2026-10', '2026-01', '2025-07', 'unstable'])(
    'accepts %s',
    (version: string) => {
      expect(validateApiVersion(version).ok).toBe(true);
    }
  );

  it.each(['2026-11', '2026', 'latest', '2026-1'])(
    'refuses %s',
    (version: string) => {
      const result: Result<string, ConfigurationError> =
        validateApiVersion(version);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain(version);
    }
  );
});

describe('createAdminClient configuration', () => {
  it('refuses an empty access token', () => {
    const result: Result<AdminClient, ConfigurationError> = createAdminClient({
      shop: 'example',
      accessToken: '  ',
      apiVersion: '2026-10',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('accessToken');
  });

  it('refuses negative or non-finite numeric options', () => {
    const result: Result<AdminClient, ConfigurationError> = createAdminClient({
      shop: 'example',
      accessToken: 'token',
      apiVersion: '2026-10',
      maxRetries: -1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('maxRetries');
  });

  it('exposes the normalized shop and version but not the token', () => {
    const result: Result<AdminClient, ConfigurationError> = createAdminClient({
      shop: 'example',
      accessToken: 'shpat_secret_token',
      apiVersion: '2026-10',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.shop).toBe('example.myshopify.com');
      expect(result.value.apiVersion).toBe('2026-10');
      expect(JSON.stringify(result.value)).not.toContain('shpat_secret_token');
    }
  });
});
