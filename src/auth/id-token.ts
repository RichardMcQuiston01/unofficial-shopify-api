import {
  AuthenticationError,
  type ConfigurationError,
} from '../errors/errors.js';
import { normalizeShopDomain } from '../client/shop.js';
import { err, ok, type Result } from '../result/result.js';
import { base64ToBytes, base64UrlToText, verifyHmac } from './crypto.js';

/** Verified claims of an App Bridge ID token (formerly "session token"). */
export interface IdTokenClaims {
  /** Normalized `example.myshopify.com`, from `dest`. */
  readonly shop: string;
  /** Staff member ID the token was issued for. */
  readonly sub: string | undefined;
  /** Session ID, unique per user and app. */
  readonly sid: string | undefined;
  readonly jti: string | undefined;
  readonly iss: string;
  readonly dest: string;
  readonly aud: string;
  /** Expiry, seconds since the epoch. */
  readonly exp: number;
  readonly nbf: number;
  readonly iat: number | undefined;
}

export interface IdTokenValidationParams {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Allowed clock difference in seconds for `exp` and `nbf`. Default 10. */
  readonly clockToleranceSeconds?: number;
  /** Clock in epoch milliseconds (for tests). */
  readonly now?: () => number;
}

interface RawClaims {
  readonly iss?: unknown;
  readonly dest?: unknown;
  readonly aud?: unknown;
  readonly sub?: unknown;
  readonly sid?: unknown;
  readonly jti?: unknown;
  readonly exp?: unknown;
  readonly nbf?: unknown;
  readonly iat?: unknown;
}

function reject(reason: string): Result<never, AuthenticationError> {
  return err(
    new AuthenticationError(
      `ID token rejected: ${reason}. Respond 401 so App Bridge fetches a fresh token and retries.`
    )
  );
}

function hostOf(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Validates an ID token from an embedded app's `Authorization: Bearer` header
 * or `id_token` parameter: HS256 signature (constant time), `exp`, `nbf`,
 * `aud` equal to the client ID, and matching `iss`/`dest` hosts.
 */
export async function validateIdToken(
  token: string,
  params: IdTokenValidationParams
): Promise<Result<IdTokenClaims, AuthenticationError>> {
  if (params.clientSecret.trim() === '' || params.clientId.trim() === '') {
    return err(
      new AuthenticationError(
        'ID token rejected: clientId or clientSecret is empty; pass the app credentials (is an environment variable unset?).'
      )
    );
  }
  const parts: string[] = token.split('.');
  const [encodedHeader, encodedPayload, encodedSignature]: (
    string | undefined
  )[] = parts;
  if (
    parts.length !== 3 ||
    encodedHeader === undefined ||
    encodedPayload === undefined ||
    encodedSignature === undefined
  ) {
    return reject('it is not a three-part JWT');
  }

  let header: { readonly alg?: unknown };
  try {
    header = JSON.parse(base64UrlToText(encodedHeader) ?? '') as {
      alg?: unknown;
    };
  } catch {
    return reject('the header is not valid JSON');
  }
  // Pin the algorithm: never trust the token to choose how it is verified.
  if (header.alg !== 'HS256') {
    return reject(
      `the algorithm must be HS256, received ${String(header.alg)}`
    );
  }
  const signature: Uint8Array | undefined = base64ToBytes(encodedSignature);
  if (
    signature === undefined ||
    !(await verifyHmac(
      params.clientSecret,
      `${encodedHeader}.${encodedPayload}`,
      signature
    ))
  ) {
    return reject('the signature does not match clientSecret');
  }

  let claims: RawClaims;
  try {
    claims = JSON.parse(base64UrlToText(encodedPayload) ?? '') as RawClaims;
  } catch {
    return reject('the payload is not valid JSON');
  }
  const tolerance: number = params.clockToleranceSeconds ?? 10;
  const nowSeconds: number = (params.now ?? Date.now)() / 1000;
  if (typeof claims.exp !== 'number' || claims.exp + tolerance <= nowSeconds) {
    return reject('"exp" is missing or in the past (the token expired)');
  }
  if (typeof claims.nbf !== 'number' || claims.nbf - tolerance > nowSeconds) {
    return reject('"nbf" is missing or in the future');
  }
  if (claims.aud !== params.clientId) {
    return reject('"aud" does not match clientId');
  }
  const issuerHost: string | undefined = hostOf(claims.iss);
  const destHost: string | undefined = hostOf(claims.dest);
  if (
    issuerHost === undefined ||
    destHost === undefined ||
    issuerHost !== destHost
  ) {
    return reject('the hostnames of "iss" and "dest" are missing or differ');
  }
  const shop: Result<string, ConfigurationError> =
    normalizeShopDomain(destHost);
  if (!shop.ok) {
    return reject(`"dest" (${destHost}) is not a .myshopify.com domain`);
  }
  return ok({
    shop: shop.value,
    sub: typeof claims.sub === 'string' ? claims.sub : undefined,
    sid: typeof claims.sid === 'string' ? claims.sid : undefined,
    jti: typeof claims.jti === 'string' ? claims.jti : undefined,
    iss: claims.iss as string,
    dest: claims.dest as string,
    aud: claims.aud,
    exp: claims.exp,
    nbf: claims.nbf,
    iat: typeof claims.iat === 'number' ? claims.iat : undefined,
  });
}
