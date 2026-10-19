import { AuthenticationError, ConfigurationError } from '../errors/errors.js';
import { normalizeShopDomain } from '../client/shop.js';
import { err, ok, type Result } from '../result/result.js';
import {
  constantTimeEqual,
  hexToBytes,
  randomHex,
  verifyHmac,
} from './crypto.js';

export interface AuthorizationUrlParams {
  /** `example`, `example.myshopify.com`, or a URL on that host. */
  readonly shop: string;
  readonly clientId: string;
  /** Access scopes to request, such as `read_products`. */
  readonly scopes: readonly string[];
  /** Must be listed as an allowed redirect URL in the app settings. */
  readonly redirectUri: string;
  /** Single-use nonce from `generateState()`, stored by the caller. */
  readonly state: string;
  /** Request an online token for the current staff member (default offline). */
  readonly perUser?: boolean;
}

/** Random single-use value for the OAuth `state` parameter. Store it, then compare it on return. */
export function generateState(): string {
  return randomHex(16);
}

/** Builds the URL to send the merchant to for approving the app's scopes. */
export function buildAuthorizationUrl(
  params: AuthorizationUrlParams
): Result<string, ConfigurationError> {
  const shop: Result<string, ConfigurationError> = normalizeShopDomain(
    params.shop
  );
  if (!shop.ok) return shop;
  if (params.clientId.trim() === '') {
    return err(
      new ConfigurationError('clientId is empty; pass the app client ID.')
    );
  }
  if (params.scopes.length === 0) {
    return err(
      new ConfigurationError(
        'scopes is empty; list at least one access scope such as "read_products".'
      )
    );
  }
  if (params.state.length < 8) {
    return err(
      new ConfigurationError(
        'state is too short; use generateState() so the callback cannot be forged.'
      )
    );
  }
  let redirect: URL;
  try {
    redirect = new URL(params.redirectUri);
  } catch (thrown: unknown) {
    return err(
      new ConfigurationError(
        `redirectUri "${params.redirectUri}" is not a valid absolute URL.`,
        { cause: thrown }
      )
    );
  }
  const localhost: boolean = ['localhost', '127.0.0.1', '[::1]'].includes(
    redirect.hostname
  );
  if (
    redirect.protocol !== 'https:' &&
    !(localhost && redirect.protocol === 'http:')
  ) {
    return err(
      new ConfigurationError(
        `redirectUri "${params.redirectUri}" must use https (http is allowed only for localhost).`
      )
    );
  }
  const url: URL = new URL(`https://${shop.value}/admin/oauth/authorize`);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('scope', params.scopes.join(','));
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('state', params.state);
  if (params.perUser === true)
    url.searchParams.append('grant_options[]', 'per-user');
  return ok(url.toString());
}

/** Callback query as a string, `URLSearchParams`, or a parsed framework object. */
export type CallbackQuery =
  | string
  | URLSearchParams
  | Readonly<Record<string, string | readonly string[] | undefined>>;

export interface CallbackValidationParams {
  readonly query: CallbackQuery;
  readonly clientSecret: string;
  /** The state you stored when starting the flow. */
  readonly expectedState: string;
  /**
   * Reject callbacks whose `timestamp` is older than this many seconds
   * (or too far in the future). Not checked when omitted.
   */
  readonly maxTimestampAgeSeconds?: number;
  /** Clock in epoch milliseconds (for tests). */
  readonly now?: () => number;
}

/** What the caller needs from a verified OAuth callback. */
export interface ValidatedCallback {
  /** Normalized `example.myshopify.com`. */
  readonly shop: string;
  /** Authorization code to pass to `exchangeAuthorizationCode`. */
  readonly code: string;
  /** Base64 admin host, when Shopify sent one (embedded apps). */
  readonly host: string | undefined;
}

function toSearchParams(query: CallbackQuery): URLSearchParams {
  if (query instanceof URLSearchParams) return new URLSearchParams(query);
  if (typeof query === 'string') {
    return new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  }
  const params: URLSearchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (typeof value === 'string') params.append(key, value);
    else for (const item of value) params.append(key, item);
  }
  return params;
}

/**
 * The string Shopify signs: every parameter except `hmac`, sorted by name,
 * re-serialized as a query string.
 */
function signedMessage(params: URLSearchParams): string {
  const entries: [string, string][] = [...params.entries()]
    .filter(([key]: [string, string]): boolean => key !== 'hmac')
    .sort(
      (
        [keyA, valueA]: [string, string],
        [keyB, valueB]: [string, string]
      ): number =>
        keyA < keyB
          ? -1
          : keyA > keyB
            ? 1
            : valueA < valueB
              ? -1
              : valueA > valueB
                ? 1
                : 0
    );
  return new URLSearchParams(entries).toString();
}

/**
 * Verifies the OAuth callback before any code is exchanged: HMAC (constant
 * time), single-use state, shop host, and optionally the timestamp age.
 */
export async function validateOAuthCallback(
  params: CallbackValidationParams
): Promise<Result<ValidatedCallback, AuthenticationError>> {
  if (params.clientSecret.trim() === '') {
    return err(
      new AuthenticationError(
        'OAuth callback rejected: clientSecret is empty; pass the app client secret (is an environment variable unset?).'
      )
    );
  }
  const query: URLSearchParams = toSearchParams(params.query);
  const hmacValues: string[] = query.getAll('hmac');
  if (hmacValues.length !== 1) {
    return err(
      new AuthenticationError(
        hmacValues.length === 0
          ? 'OAuth callback rejected: the "hmac" parameter is missing.'
          : 'OAuth callback rejected: the "hmac" parameter appears more than once.'
      )
    );
  }
  const signature: Uint8Array | undefined = hexToBytes(hmacValues[0] ?? '');
  if (
    signature === undefined ||
    !(await verifyHmac(params.clientSecret, signedMessage(query), signature))
  ) {
    return err(
      new AuthenticationError(
        'OAuth callback rejected: the "hmac" signature does not match. ' +
          'Check clientSecret, and that the query string reached this function unmodified.'
      )
    );
  }

  const state: string | null = query.get('state');
  if (
    state === null ||
    params.expectedState === '' ||
    !(await constantTimeEqual(state, params.expectedState))
  ) {
    return err(
      new AuthenticationError(
        'OAuth callback rejected: "state" is missing or does not match the value stored when the flow started.'
      )
    );
  }
  const shop: Result<string, ConfigurationError> = normalizeShopDomain(
    query.get('shop') ?? ''
  );
  if (!shop.ok) {
    return err(
      new AuthenticationError(
        `OAuth callback rejected: the "shop" parameter is not a valid .myshopify.com domain (${shop.error.message})`
      )
    );
  }
  if (params.maxTimestampAgeSeconds !== undefined) {
    const timestamp: number = Number(query.get('timestamp'));
    const nowSeconds: number = (params.now ?? Date.now)() / 1000;
    if (
      !Number.isFinite(timestamp) ||
      Math.abs(nowSeconds - timestamp) > params.maxTimestampAgeSeconds
    ) {
      return err(
        new AuthenticationError(
          `OAuth callback rejected: "timestamp" is missing or more than ${String(params.maxTimestampAgeSeconds)} seconds from now.`
        )
      );
    }
  }
  const code: string | null = query.get('code');
  if (code === null || code === '') {
    return err(
      new AuthenticationError(
        'OAuth callback rejected: the "code" parameter is missing; the merchant may have declined the install.'
      )
    );
  }
  return ok({ shop: shop.value, code, host: query.get('host') ?? undefined });
}
