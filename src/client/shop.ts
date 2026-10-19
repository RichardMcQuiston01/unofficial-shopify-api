import { ConfigurationError } from '../errors/errors.js';
import { err, ok, type Result } from '../result/result.js';

const shopHostPattern: RegExp = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const apiVersionPattern: RegExp = /^(\d{4}-(01|04|07|10)|unstable)$/;

/**
 * Normalizes `example`, `example.myshopify.com` or a URL on that host to the
 * bare `example.myshopify.com`. Anything else is refused so an access token
 * can never be sent to an arbitrary host.
 */
export function normalizeShopDomain(
  shop: string
): Result<string, ConfigurationError> {
  const trimmed: string = shop.trim().toLowerCase();
  const withoutScheme: string = trimmed.replace(/^https:\/\//, '');
  const host: string = (withoutScheme.split('/')[0] ?? '').trim();
  const candidate: string = host.includes('.') ? host : `${host}.myshopify.com`;
  if (!shopHostPattern.test(candidate)) {
    return err(
      new ConfigurationError(
        `Invalid shop "${shop}": expected a name like "example" or "example.myshopify.com". ` +
          'Custom domains are not valid for the Admin API; use the .myshopify.com domain.'
      )
    );
  }
  return ok(candidate);
}

/** Accepts quarterly versions (`2026-10`) and `unstable`. */
export function validateApiVersion(
  apiVersion: string
): Result<string, ConfigurationError> {
  if (!apiVersionPattern.test(apiVersion)) {
    return err(
      new ConfigurationError(
        `Invalid apiVersion "${apiVersion}": expected a quarterly version ` +
          'such as "2026-10" (01, 04, 07 or 10), or "unstable".'
      )
    );
  }
  return ok(apiVersion);
}
