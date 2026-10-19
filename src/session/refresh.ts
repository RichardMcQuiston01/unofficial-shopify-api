import { refreshAccessToken } from '../auth/grants.js';
import type {
  AccessTokenGrant,
  AppCredentials,
  TokenRequestOptions,
} from '../auth/token-endpoint.js';
import { AuthenticationError } from '../errors/errors.js';
import { err, ok, type Result } from '../result/result.js';
import { canRefresh, sessionFromGrant, type Session } from './session.js';

/**
 * Refreshes an expiring offline session and returns the replacement. Store
 * the result: Shopify issues a new refresh token each time. Online sessions
 * have no refresh token; run `exchangeIdToken` again with a fresh ID token.
 */
export async function refreshSession(
  session: Session,
  credentials: AppCredentials,
  options: TokenRequestOptions = {}
): Promise<Result<Session>> {
  if (session.isOnline) {
    return err(
      new AuthenticationError(
        `Session ${session.id} is an online session and has no refresh token; ` +
          'exchange a fresh ID token with exchangeIdToken instead.',
        { context: { shop: session.shop } }
      )
    );
  }
  if (
    session.refreshToken === undefined ||
    !canRefresh(session, (options.now ?? Date.now)())
  ) {
    return err(
      new AuthenticationError(
        `Session ${session.id} has no usable refresh token (missing or expired); ` +
          'send the merchant through authorization again.',
        { context: { shop: session.shop } }
      )
    );
  }
  const grant: Result<AccessTokenGrant> = await refreshAccessToken(
    {
      ...credentials,
      shop: session.shop,
      refreshToken: session.refreshToken,
    },
    options
  );
  if (!grant.ok) return grant;
  return ok(sessionFromGrant(session.shop, grant.value));
}
