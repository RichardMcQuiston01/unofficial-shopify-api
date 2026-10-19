import {
  createAdminClient,
  exchangeIdToken,
  isAccessTokenExpired,
  offlineSessionId,
  refreshSession,
  sessionFromGrant,
  validateIdToken,
  type AccessTokenGrant,
  type AdminClient,
  type AuthenticationError,
  type IdTokenClaims,
  type Result,
  type Session,
  type ShopifyError,
} from '@richardmcquiston01/unofficial-shopify-api';
import { fetchOption, type AppContext } from './app.js';

export interface AuthenticatedRequest {
  readonly shop: string;
  readonly client: AdminClient;
  readonly session: Session;
}

/**
 * For an embedded app: authenticates a request from App Bridge and returns an
 * Admin client for its shop. Call it at the top of every API route.
 *
 * On a failure, answer 401 with the header `X-Shopify-Retry-Invalid-Session-Request: 1`
 * so App Bridge fetches a fresh ID token and retries.
 */
export async function authenticateAdmin(
  request: Request,
  context: AppContext
): Promise<Result<AuthenticatedRequest>> {
  const idToken: string = (request.headers.get('authorization') ?? '').replace(
    /^Bearer /i,
    ''
  );
  const claims: Result<IdTokenClaims, AuthenticationError> =
    await validateIdToken(idToken, {
      clientId: context.config.clientId,
      clientSecret: context.config.clientSecret,
    });
  if (!claims.ok) return claims;
  const shop: string = claims.value.shop;

  // Use the stored offline token while it is valid.
  const stored: Result<Session | null> = await context.sessions.load(
    offlineSessionId(shop)
  );
  if (!stored.ok) return stored;
  let session: Session | null = stored.value;

  if (
    session !== null &&
    isAccessTokenExpired(session) &&
    session.refreshToken !== undefined
  ) {
    // Expiring offline tokens refresh without the merchant; store the new pair.
    const refreshed: Result<Session> = await refreshSession(
      session,
      {
        clientId: context.config.clientId,
        clientSecret: context.config.clientSecret,
      },
      fetchOption(context)
    );
    if (refreshed.ok) {
      session = refreshed.value;
      await context.sessions.store(session);
    } else {
      session = null; // Fall through to a fresh token exchange.
    }
  }

  if (session === null || isAccessTokenExpired(session)) {
    const grant: Result<AccessTokenGrant> = await exchangeIdToken(
      {
        shop,
        clientId: context.config.clientId,
        clientSecret: context.config.clientSecret,
        idToken,
      },
      fetchOption(context)
    );
    if (!grant.ok) return grant;
    session = sessionFromGrant(shop, grant.value);
    const saved: Result<void> = await context.sessions.store(session);
    if (!saved.ok) return saved;
  }

  const client: Result<AdminClient> = createAdminClient({
    shop,
    accessToken: session.accessToken,
    apiVersion: context.config.apiVersion,
    ...fetchOption(context),
  });
  if (!client.ok) return client;
  return { ok: true, value: { shop, client: client.value, session } };
}

/** The response to send when `authenticateAdmin` fails. */
export function unauthorized(error: ShopifyError): Response {
  return new Response(error.message, {
    status: 401,
    headers: { 'X-Shopify-Retry-Invalid-Session-Request': '1' },
  });
}
