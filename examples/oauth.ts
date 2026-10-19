import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  generateState,
  normalizeShopDomain,
  sessionFromGrant,
  validateOAuthCallback,
  type AccessTokenGrant,
  type ConfigurationError,
  type Result,
  type ValidatedCallback,
  type AuthenticationError,
} from '@richardmcquiston01/unofficial-shopify-api';
import { fetchOption, type AppContext } from './app.js';

const stateCookie: string = 'shopify_oauth_state';

/** Step 1, `GET /api/auth/install?shop=example.myshopify.com`: send the merchant to Shopify. */
export function beginInstall(request: Request, context: AppContext): Response {
  const shop: Result<string, ConfigurationError> = normalizeShopDomain(
    new URL(request.url).searchParams.get('shop') ?? ''
  );
  if (!shop.ok) return new Response(shop.error.message, { status: 400 });

  const state: string = generateState();
  const url: Result<string, ConfigurationError> = buildAuthorizationUrl({
    shop: shop.value,
    clientId: context.config.clientId,
    scopes: context.config.scopes,
    redirectUri: `${context.config.appUrl}/api/auth/callback`,
    state,
  });
  if (!url.ok) return new Response(url.error.message, { status: 500 });

  // Remember the state for the callback: HttpOnly so scripts cannot read it,
  // Lax so it survives the redirect back from Shopify.
  return new Response(null, {
    status: 302,
    headers: {
      location: url.value,
      'set-cookie': `${stateCookie}=${state}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}

function cookieValue(request: Request, name: string): string {
  const header: string = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}

/** Step 2, `GET /api/auth/callback`: verify Shopify's redirect, then trade the code for a token. */
export async function finishInstall(
  request: Request,
  context: AppContext
): Promise<Response> {
  const callback: Result<ValidatedCallback, AuthenticationError> =
    await validateOAuthCallback({
      query: new URL(request.url).searchParams,
      clientSecret: context.config.clientSecret,
      expectedState: cookieValue(request, stateCookie),
      maxTimestampAgeSeconds: 300,
    });
  if (!callback.ok)
    return new Response(callback.error.message, { status: 401 });

  const grant: Result<AccessTokenGrant> = await exchangeAuthorizationCode(
    {
      shop: callback.value.shop,
      clientId: context.config.clientId,
      clientSecret: context.config.clientSecret,
      code: callback.value.code,
    },
    fetchOption(context)
  );
  if (!grant.ok) return new Response(grant.error.message, { status: 502 });

  const stored: Result<void> = await context.sessions.store(
    sessionFromGrant(callback.value.shop, grant.value)
  );
  if (!stored.ok) return new Response(stored.error.message, { status: 500 });

  return new Response(null, {
    status: 302,
    headers: {
      location: `${context.config.appUrl}/?shop=${callback.value.shop}`,
      'set-cookie': `${stateCookie}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}
