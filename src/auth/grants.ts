import { ConfigurationError } from '../errors/errors.js';
import type { Result } from '../result/result.js';
import {
  checkGrantInputs,
  requestAccessToken,
  type AccessTokenGrant,
  type AppCredentials,
  type TokenRequestOptions,
} from './token-endpoint.js';

const tokenExchangeGrant: string =
  'urn:ietf:params:oauth:grant-type:token-exchange';
const idTokenType: string = 'urn:ietf:params:oauth:token-type:id_token';
const offlineTokenType: string =
  'urn:shopify:params:oauth:token-type:offline-access-token';
const onlineTokenType: string =
  'urn:shopify:params:oauth:token-type:online-access-token';

export interface ExchangeAuthorizationCodeParams extends AppCredentials {
  readonly shop: string;
  /** The `code` query parameter from the validated OAuth callback. */
  readonly code: string;
  /**
   * Ask for an expiring offline token with a refresh token. Default true:
   * public apps must use expiring tokens for the GraphQL Admin API.
   */
  readonly expiring?: boolean;
}

/** Authorization code grant: trades the callback `code` for an access token. */
export function exchangeAuthorizationCode(
  params: ExchangeAuthorizationCodeParams,
  options: TokenRequestOptions = {}
): Promise<Result<AccessTokenGrant>> {
  const checked: Result<string, ConfigurationError> = checkGrantInputs(
    params.shop,
    params
  );
  if (!checked.ok) return Promise.resolve(checked);
  if (params.code.trim() === '') {
    return Promise.resolve(
      failConfiguration('code is empty; pass the code from the OAuth callback.')
    );
  }
  return requestAccessToken(
    checked.value,
    {
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code: params.code,
      expiring: params.expiring === false ? '0' : '1',
    },
    'Authorization code exchange',
    options
  );
}

export interface ExchangeIdTokenParams extends AppCredentials {
  readonly shop: string;
  /** A validated ID token (session token) from App Bridge. */
  readonly idToken: string;
  /** `offline` (default) for background work, `online` for the current staff member. */
  readonly tokenType?: 'offline' | 'online';
  /**
   * For offline tokens, ask for an expiring token with a refresh token.
   * Default true. Ignored for online tokens.
   */
  readonly expiring?: boolean;
}

/** Token exchange grant: trades an App Bridge ID token for an access token. */
export function exchangeIdToken(
  params: ExchangeIdTokenParams,
  options: TokenRequestOptions = {}
): Promise<Result<AccessTokenGrant>> {
  const checked: Result<string, ConfigurationError> = checkGrantInputs(
    params.shop,
    params
  );
  if (!checked.ok) return Promise.resolve(checked);
  if (params.idToken.trim() === '') {
    return Promise.resolve(
      failConfiguration('idToken is empty; pass the ID token from App Bridge.')
    );
  }
  const online: boolean = params.tokenType === 'online';
  return requestAccessToken(
    checked.value,
    {
      client_id: params.clientId,
      client_secret: params.clientSecret,
      grant_type: tokenExchangeGrant,
      subject_token: params.idToken,
      subject_token_type: idTokenType,
      requested_token_type: online ? onlineTokenType : offlineTokenType,
      ...(online ? {} : { expiring: params.expiring === false ? '0' : '1' }),
    },
    `Token exchange (${online ? 'online' : 'offline'})`,
    options
  );
}

export interface RefreshAccessTokenParams extends AppCredentials {
  readonly shop: string;
  readonly refreshToken: string;
}

/**
 * Refresh token grant. Shopify returns a new access token and a new refresh
 * token: store both, and refresh from the new pair next time. If a refresh
 * times out or fails with a 5xx, retry with the refresh token you still hold.
 */
export function refreshAccessToken(
  params: RefreshAccessTokenParams,
  options: TokenRequestOptions = {}
): Promise<Result<AccessTokenGrant>> {
  const checked: Result<string, ConfigurationError> = checkGrantInputs(
    params.shop,
    params
  );
  if (!checked.ok) return Promise.resolve(checked);
  if (params.refreshToken.trim() === '') {
    return Promise.resolve(
      failConfiguration('refreshToken is empty; pass the stored refresh token.')
    );
  }
  return requestAccessToken(
    checked.value,
    {
      client_id: params.clientId,
      client_secret: params.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: params.refreshToken,
    },
    'Access token refresh',
    options
  );
}

function failConfiguration(
  message: string
): Result<AccessTokenGrant, ConfigurationError> {
  return { ok: false, error: new ConfigurationError(message) };
}
