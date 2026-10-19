import { ConfigurationError } from '../errors/errors.js';
import { err, type Result } from '../result/result.js';
import { createGraphqlClient, type GraphqlClient } from './graphql-client.js';
import { normalizeShopDomain, validateApiVersion } from './shop.js';
import type {
  AdminResponse,
  GraphqlClientOptions,
  GraphqlDocument,
  GraphqlRequestOptions,
  GraphqlVariables,
} from './types.js';

export interface StorefrontClientOptions extends GraphqlClientOptions {
  /** `example`, `example.myshopify.com`, or a URL on that host. */
  readonly shop: string;
  /** Explicit API version, `YYYY-MM` (such as `2026-10`) or `unstable`. */
  readonly apiVersion: string;
  /**
   * Public token for browsers and mobile apps, where buyers can see it. Sent
   * as `X-Shopify-Storefront-Access-Token`.
   */
  readonly publicAccessToken?: string;
  /**
   * Private token for servers only; never ship it to a client. Sent as
   * `Shopify-Storefront-Private-Token`.
   */
  readonly privateAccessToken?: string;
  /**
   * With neither token the client makes tokenless requests, which only reach
   * the features that do not need authentication (products, collections, cart).
   */
}

export interface StorefrontRequestOptions<
  TVariables extends GraphqlVariables = GraphqlVariables,
> extends GraphqlRequestOptions<TVariables> {
  /**
   * The buyer's IP address, for requests that result from buyer traffic.
   * Shopify uses it for bot protection and to avoid throttling all buyers
   * together. Only meaningful with a private token.
   */
  readonly buyerIp?: string;
}

/** Client for one shop's Storefront GraphQL API. */
export interface StorefrontClient {
  readonly shop: string;
  readonly apiVersion: string;
  request<
    TData = unknown,
    TVariables extends GraphqlVariables = GraphqlVariables,
  >(
    document: GraphqlDocument<TData, TVariables>,
    options?: StorefrontRequestOptions<TVariables>
  ): Promise<Result<AdminResponse<TData>>>;
}

const buyerIpHeader: string = 'Shopify-Storefront-Buyer-IP';
const ipPattern: RegExp = /^[0-9a-fA-F:.]{2,45}$/;

/**
 * Creates a Storefront GraphQL client. Returns an `Err` for invalid
 * configuration instead of throwing.
 */
export function createStorefrontClient(
  options: StorefrontClientOptions
): Result<StorefrontClient, ConfigurationError> {
  const shop: Result<string, ConfigurationError> = normalizeShopDomain(
    options.shop
  );
  if (!shop.ok) return shop;
  const apiVersion: Result<string, ConfigurationError> = validateApiVersion(
    options.apiVersion
  );
  if (!apiVersion.ok) return apiVersion;

  const { publicAccessToken, privateAccessToken, ...shared } = options;
  if (publicAccessToken !== undefined && privateAccessToken !== undefined) {
    return err(
      new ConfigurationError(
        `Storefront client for ${shop.value} was given both a public and a private token; pass only one.`
      )
    );
  }
  if (
    (publicAccessToken !== undefined && publicAccessToken.trim() === '') ||
    (privateAccessToken !== undefined && privateAccessToken.trim() === '')
  ) {
    return err(
      new ConfigurationError(
        `A Storefront access token for ${shop.value} is empty; pass a token or omit it for tokenless access.`
      )
    );
  }
  const authHeaders: Record<string, string> =
    publicAccessToken !== undefined
      ? { 'X-Shopify-Storefront-Access-Token': publicAccessToken }
      : privateAccessToken !== undefined
        ? { 'Shopify-Storefront-Private-Token': privateAccessToken }
        : {};

  const client: Result<GraphqlClient, ConfigurationError> = createGraphqlClient(
    {
      ...shared,
      shop: shop.value,
      apiVersion: apiVersion.value,
      endpoint: `https://${shop.value}/api/${apiVersion.value}/graphql.json`,
      authHeaders,
    }
  );
  if (!client.ok) return client;
  const base: GraphqlClient = client.value;

  return {
    ok: true,
    value: {
      shop: base.shop,
      apiVersion: base.apiVersion,
      request: <
        TData = unknown,
        TVariables extends GraphqlVariables = GraphqlVariables,
      >(
        document: GraphqlDocument<TData, TVariables>,
        requestOptions: StorefrontRequestOptions<TVariables> = {}
      ): Promise<Result<AdminResponse<TData>>> => {
        const { buyerIp, ...rest } = requestOptions;
        if (buyerIp === undefined) return base.request(document, rest);
        if (!ipPattern.test(buyerIp)) {
          return Promise.resolve(
            err(
              new ConfigurationError(
                `buyerIp "${buyerIp}" is not an IPv4 or IPv6 address.`
              )
            )
          );
        }
        return base.request(document, {
          ...rest,
          headers: { ...rest.headers, [buyerIpHeader]: buyerIp },
        });
      },
    },
  };
}
