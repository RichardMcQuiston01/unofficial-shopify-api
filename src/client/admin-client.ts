import { ConfigurationError } from '../errors/errors.js';
import { err, type Result } from '../result/result.js';
import { createGraphqlClient, type GraphqlClient } from './graphql-client.js';
import { normalizeShopDomain, validateApiVersion } from './shop.js';
import type { AdminClientOptions } from './types.js';

/** Client for one shop's Admin GraphQL API. Holds the token privately. */
export type AdminClient = GraphqlClient;

/**
 * Creates an Admin GraphQL client. Returns an `Err` for invalid configuration
 * instead of throwing.
 */
export function createAdminClient(
  options: AdminClientOptions
): Result<AdminClient, ConfigurationError> {
  const shop: Result<string, ConfigurationError> = normalizeShopDomain(
    options.shop
  );
  if (!shop.ok) return shop;
  const apiVersion: Result<string, ConfigurationError> = validateApiVersion(
    options.apiVersion
  );
  if (!apiVersion.ok) return apiVersion;
  if (options.accessToken.trim() === '') {
    return err(
      new ConfigurationError(
        `accessToken for shop ${shop.value} is empty; pass the Admin API access token.`
      )
    );
  }
  const { accessToken, ...shared } = options;
  return createGraphqlClient({
    ...shared,
    shop: shop.value,
    apiVersion: apiVersion.value,
    endpoint: `https://${shop.value}/admin/api/${apiVersion.value}/graphql.json`,
    authHeaders: { 'X-Shopify-Access-Token': accessToken },
  });
}
