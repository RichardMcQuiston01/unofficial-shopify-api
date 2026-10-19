import {
  AuthenticationError,
  ConfigurationError,
  HttpError,
  NetworkError,
  ShopifyError,
  ThrottledError,
  type ShopifyErrorContext,
} from '../errors/errors.js';
import { snippet } from '../internal/text.js';
import { parseRetryAfterMs } from '../client/retry.js';
import { normalizeShopDomain } from '../client/shop.js';
import { err, ok, type Result } from '../result/result.js';

/** The staff member an online access token belongs to. */
export interface AssociatedUser {
  readonly id: number;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly accountOwner?: boolean;
  readonly locale?: string;
  readonly collaborator?: boolean;
}

/** An access token and its metadata, as returned by Shopify's token endpoint. */
export interface AccessTokenGrant {
  readonly accessToken: string;
  readonly scope: readonly string[];
  /** Epoch milliseconds; undefined for a non-expiring token. */
  readonly expiresAt: number | undefined;
  /** Present for expiring offline tokens only. */
  readonly refreshToken: string | undefined;
  readonly refreshTokenExpiresAt: number | undefined;
  /** Present for online tokens only. */
  readonly associatedUser: AssociatedUser | undefined;
  /** Scopes the user may actually use: the app's scopes intersected with the user's permissions. */
  readonly associatedUserScope: readonly string[] | undefined;
}

export interface TokenRequestOptions {
  /** Custom `fetch`, for tests, proxies or runtimes without a global. */
  readonly fetch?: typeof fetch;
  /** Request timeout in milliseconds. Default 30000. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Clock used to turn `expires_in` into `expiresAt` (for tests). */
  readonly now?: () => number;
}

export interface AppCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

const defaultTimeoutMs: number = 30_000;

/** Validates the shop and credentials shared by every grant. */
export function checkGrantInputs(
  shop: string,
  credentials: AppCredentials
): Result<string, ConfigurationError> {
  const shopResult: Result<string, ConfigurationError> =
    normalizeShopDomain(shop);
  if (!shopResult.ok) return shopResult;
  if (credentials.clientId.trim() === '') {
    return err(
      new ConfigurationError('clientId is empty; pass the app client ID.')
    );
  }
  if (credentials.clientSecret.trim() === '') {
    return err(
      new ConfigurationError(
        'clientSecret is empty; pass the app client secret.'
      )
    );
  }
  return shopResult;
}

/**
 * POSTs a form-encoded grant to `https://<shop>/admin/oauth/access_token` and
 * maps the outcome to a `Result`. Secrets are sent in the body and never
 * appear in errors.
 */
export async function requestAccessToken(
  shop: string,
  parameters: Readonly<Record<string, string>>,
  operation: string,
  options: TokenRequestOptions
): Promise<Result<AccessTokenGrant>> {
  const context: ShopifyErrorContext = { operation, shop };
  const fetchImplementation: typeof fetch | undefined =
    options.fetch ?? (typeof fetch === 'function' ? fetch : undefined);
  if (fetchImplementation === undefined) {
    return err(
      new ConfigurationError(
        'No global fetch is available in this runtime; pass one as the `fetch` option.',
        { context }
      )
    );
  }
  const timeoutSignal: AbortSignal = AbortSignal.timeout(
    options.timeoutMs ?? defaultTimeoutMs
  );
  const signal: AbortSignal =
    options.signal === undefined
      ? timeoutSignal
      : AbortSignal.any([options.signal, timeoutSignal]);

  let response: Response;
  try {
    response = await fetchImplementation(
      `https://${shop}/admin/oauth/access_token`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams(parameters).toString(),
        signal,
      }
    );
  } catch (thrown: unknown) {
    const reason: string =
      thrown instanceof Error ? thrown.message : String(thrown);
    return err(
      new NetworkError(
        `${operation} on ${shop} failed before a response was received: ${reason}.`,
        { cause: thrown, context }
      )
    );
  }

  const requestId: string | undefined =
    response.headers.get('x-request-id') ?? undefined;
  const withStatus: ShopifyErrorContext = {
    ...context,
    status: response.status,
    ...(requestId === undefined ? {} : { requestId }),
  };
  let text: string;
  try {
    text = await response.text();
  } catch (thrown: unknown) {
    return err(
      new NetworkError(
        `${operation} on ${shop}: the connection failed while reading the response body (HTTP ${String(response.status)}).`,
        { cause: thrown, context: withStatus }
      )
    );
  }
  if (!response.ok) {
    return err(tokenEndpointFailure(response, text, operation, withStatus));
  }
  return parseGrant(text, operation, withStatus, (options.now ?? Date.now)());
}

function tokenEndpointFailure(
  response: Response,
  text: string,
  operation: string,
  context: ShopifyErrorContext
): ShopifyError {
  const shop: string = context.shop ?? 'the shop';
  const status: number = response.status;
  const detail: string = text === '' ? '' : `: "${snippet(text)}"`;
  if (status === 400) {
    return new AuthenticationError(
      `${operation} on ${shop}: Shopify rejected the grant (HTTP 400)${detail}. ` +
        'For token exchange this usually means the ID token is expired or invalid; ' +
        'get a fresh one and try again. For a code exchange the code may be used or expired.',
      { context }
    );
  }
  if (status === 401 || status === 403) {
    return new AuthenticationError(
      `${operation} on ${shop}: Shopify rejected the app credentials (HTTP ${String(status)})${detail}. Check clientId and clientSecret.`,
      { context }
    );
  }
  if (status === 429) {
    const retryAfterMs: number | undefined = parseRetryAfterMs(
      response.headers.get('retry-after')
    );
    return new ThrottledError(
      `${operation} on ${shop}: Shopify rate limit exceeded (HTTP 429).`,
      { context, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }
    );
  }
  return new HttpError(
    `${operation} on ${shop}: Shopify returned HTTP ${String(status)}${detail}.`,
    { context }
  );
}

/* eslint-disable @typescript-eslint/naming-convention -- Shopify's token endpoint uses snake_case. */
interface RawUser {
  readonly id?: unknown;
  readonly first_name?: unknown;
  readonly last_name?: unknown;
  readonly email?: unknown;
  readonly email_verified?: unknown;
  readonly account_owner?: unknown;
  readonly locale?: unknown;
  readonly collaborator?: unknown;
}

interface RawGrant {
  readonly access_token?: unknown;
  readonly scope?: unknown;
  readonly expires_in?: unknown;
  readonly refresh_token?: unknown;
  readonly refresh_token_expires_in?: unknown;
  readonly associated_user?: RawUser | null;
  readonly associated_user_scope?: unknown;
}

/* eslint-enable @typescript-eslint/naming-convention */

function parseGrant(
  text: string,
  operation: string,
  context: ShopifyErrorContext,
  now: number
): Result<AccessTokenGrant> {
  const shop: string = context.shop ?? 'the shop';
  let raw: RawGrant;
  try {
    raw = JSON.parse(text) as RawGrant;
  } catch (thrown: unknown) {
    return err(
      new HttpError(
        `${operation} on ${shop}: Shopify returned HTTP 200 with a body that is not valid JSON: "${snippet(text)}".`,
        { cause: thrown, context }
      )
    );
  }
  if (typeof raw.access_token !== 'string' || raw.access_token === '') {
    return err(
      new HttpError(
        `${operation} on ${shop}: the response had no access_token.`,
        { context }
      )
    );
  }
  const refreshToken: string | undefined =
    typeof raw.refresh_token === 'string' ? raw.refresh_token : undefined;
  return ok({
    accessToken: raw.access_token,
    scope: splitScopes(raw.scope),
    expiresAt: expiryFrom(raw.expires_in, now),
    refreshToken,
    refreshTokenExpiresAt:
      refreshToken === undefined
        ? undefined
        : expiryFrom(raw.refresh_token_expires_in, now),
    associatedUser: parseUser(raw.associated_user),
    associatedUserScope:
      typeof raw.associated_user_scope === 'string'
        ? splitScopes(raw.associated_user_scope)
        : undefined,
  });
}

function splitScopes(value: unknown): readonly string[] {
  return typeof value === 'string'
    ? value
        .split(',')
        .map((scope: string): string => scope.trim())
        .filter((scope: string): boolean => scope !== '')
    : [];
}

function expiryFrom(seconds: unknown, now: number): number | undefined {
  return typeof seconds === 'number' && Number.isFinite(seconds)
    ? now + seconds * 1000
    : undefined;
}

function parseUser(
  raw: RawUser | null | undefined
): AssociatedUser | undefined {
  if (raw === null || raw === undefined || typeof raw.id !== 'number') {
    return undefined;
  }
  return {
    id: raw.id,
    ...(typeof raw.first_name === 'string'
      ? { firstName: raw.first_name }
      : {}),
    ...(typeof raw.last_name === 'string' ? { lastName: raw.last_name } : {}),
    ...(typeof raw.email === 'string' ? { email: raw.email } : {}),
    ...(typeof raw.email_verified === 'boolean'
      ? { emailVerified: raw.email_verified }
      : {}),
    ...(typeof raw.account_owner === 'boolean'
      ? { accountOwner: raw.account_owner }
      : {}),
    ...(typeof raw.locale === 'string' ? { locale: raw.locale } : {}),
    ...(typeof raw.collaborator === 'boolean'
      ? { collaborator: raw.collaborator }
      : {}),
  };
}
