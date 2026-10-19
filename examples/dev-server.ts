/**
 * A small local server that mounts the example handlers, so the install and
 * webhook steps of docs/LIVE-TESTING.md can run against a real shop through a
 * tunnel. For testing only: sessions live in memory and nothing here is hardened.
 *
 *   SHOPIFY_CLIENT_ID=... SHOPIFY_CLIENT_SECRET=... SHOPIFY_SCOPES=read_products,write_products \
 *   APP_URL=https://<tunnel-host> SHOPIFY_API_VERSION=2026-10 npm run dev-server
 *
 * Listens on http://localhost:3000 (set PORT to change it). After a successful
 * install it subscribes the shop to the example webhooks.
 *
 * A second listener on 127.0.0.1:3001 (DEV_CONTROL_PORT) is never tunneled and
 * runs the live checks that need a real delivery or token:
 *   /replay   sends the last verified webhook again: expect "duplicate", no rerun
 *   /tamper   sends it with the body changed: expect HTTP 401
 *   /refresh  refreshes the stored offline token and calls the Admin API with it
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { pathToFileURL } from 'node:url';
import {
  createAdminClient,
  createMemorySessionStorage,
  normalizeShopDomain,
  offlineSessionId,
  refreshSession,
  type AdminClient,
  type AdminResponse,
  type ConfigurationError,
  type Result,
  type Session,
  type SessionStorage,
  type SyncReport,
  type WebhookOutcome,
} from '@richardmcquiston01/unofficial-shopify-api';
import {
  configFromEnv,
  fetchOption,
  type AppConfig,
  type AppContext,
} from './app.js';
import { beginInstall, finishInstall } from './oauth.js';
import { createWebhookHandler, subscribeToWebhooks } from './webhooks.js';

type Handler = (request: Request) => Promise<Response>;

function text(body: string, status: number = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

async function home(url: URL, context: AppContext): Promise<Response> {
  const requested: string = url.searchParams.get('shop') ?? '';
  if (requested === '') {
    return text(
      'Dev server is running. Install with /api/auth/install?shop=<your-store>.'
    );
  }
  const shop: Result<string, ConfigurationError> =
    normalizeShopDomain(requested);
  if (!shop.ok) return text(shop.error.message, 400);
  const stored: Result<Session | null> = await context.sessions.load(
    offlineSessionId(shop.value)
  );
  if (!stored.ok) return text(stored.error.message, 500);
  if (stored.value === null) {
    return text(`No session stored for ${shop.value}.`, 404);
  }
  const session: Session = stored.value;
  const expires: string =
    session.expiresAt === undefined
      ? 'does not expire'
      : `expires ${new Date(session.expiresAt).toISOString()}`;
  return text(
    `Installed on ${session.shop}. Scopes: ${session.scope.join(', ')}. ` +
      `Access token stored (${expires}); refresh token ${session.refreshToken === undefined ? 'absent' : 'present'}.`
  );
}

/** After a successful install, subscribe the shop to the example webhooks. */
async function subscribeAfterInstall(
  response: Response,
  context: AppContext
): Promise<string | undefined> {
  const location: string | null = response.headers.get('location');
  if (response.status !== 302 || location === null) return undefined;
  const shopParam: string = new URL(location).searchParams.get('shop') ?? '';
  const stored: Result<Session | null> = await context.sessions.load(
    offlineSessionId(shopParam)
  );
  if (!stored.ok || stored.value === null) {
    console.log(`Installed ${shopParam}, but no session could be loaded.`);
    return undefined;
  }
  const client: Result<AdminClient> = createAdminClient({
    shop: stored.value.shop,
    apiVersion: context.config.apiVersion,
    accessToken: stored.value.accessToken,
    ...fetchOption(context),
  });
  if (!client.ok) {
    console.log(`Could not create an Admin client: ${client.error.message}`);
    return stored.value.shop;
  }
  const report: Result<SyncReport> = await subscribeToWebhooks(
    client.value,
    context
  );
  console.log(
    report.ok
      ? `Webhooks for ${stored.value.shop}: ${String(report.value.created.length)} created, ${String(report.value.unchanged.length)} unchanged.`
      : `Webhook subscription failed: ${report.error.message}`
  );
  return stored.value.shop;
}

interface CapturedWebhook {
  readonly rawBody: string;
  readonly headers: readonly (readonly [string, string])[];
}

interface DevState {
  latest: Result<WebhookOutcome> | undefined;
  pending: CapturedWebhook | undefined;
  captured: CapturedWebhook | undefined;
  lastShop: string | undefined;
}

export interface DevServer {
  /** Public routes: what the tunnel exposes. */
  readonly app: Handler;
  /** Live-check routes: serve on loopback only, never through the tunnel. */
  readonly control: Handler;
}

/** Request headers that describe the transport, not the delivery. */
const transportHeaders: ReadonlySet<string> = new Set<string>([
  'content-length',
  'host',
  'connection',
  'transfer-encoding',
  'accept-encoding',
]);

function describeOutcome(result: Result<WebhookOutcome> | undefined): string {
  if (result === undefined) return 'no result';
  return result.ok
    ? `"${result.value.status}" (${result.value.topic} from ${result.value.shop})`
    : `rejected (${result.error.message})`;
}

/** Builds the public routes and the loopback-only control routes. */
export function createDevServer(context: AppContext): DevServer {
  const state: DevState = {
    latest: undefined,
    pending: undefined,
    captured: undefined,
    lastShop: undefined,
  };
  const take = (): Result<WebhookOutcome> | undefined => {
    const value: Result<WebhookOutcome> | undefined = state.latest;
    state.latest = undefined;
    return value;
  };
  const webhooks: Handler = createWebhookHandler(context, {
    onResult: (result: Result<WebhookOutcome>): void => {
      state.latest = result;
      // Keep only deliveries that passed verification, so a stranger's POST
      // cannot replace the real one that /replay and /tamper work from.
      if (result.ok) state.captured = state.pending;
      console.log(`Webhook: ${describeOutcome(result)}`);
    },
  });

  /** Runs one delivery through the handler and reports how it was judged. */
  async function deliver(
    rawBody: string,
    headers: readonly (readonly [string, string])[]
  ): Promise<{
    response: Response;
    result: Result<WebhookOutcome> | undefined;
  }> {
    state.pending = { rawBody, headers };
    const forwarded: Headers = new Headers();
    for (const [name, value] of headers) {
      if (!transportHeaders.has(name.toLowerCase())) forwarded.set(name, value);
    }
    const response: Response = await webhooks(
      new Request(`${context.config.appUrl}/api/webhooks`, {
        method: 'POST',
        headers: forwarded,
        body: rawBody,
      })
    );
    return { response, result: take() };
  }

  const app: Handler = async (request: Request): Promise<Response> => {
    const url: URL = new URL(request.url);
    const route: string = `${request.method} ${url.pathname}`;
    switch (route) {
      case 'GET /':
        return home(url, context);
      case 'GET /api/auth/install':
        return beginInstall(request, context);
      case 'GET /api/auth/callback': {
        const response: Response = await finishInstall(request, context);
        state.lastShop =
          (await subscribeAfterInstall(response, context)) ?? state.lastShop;
        return response;
      }
      case 'POST /api/webhooks': {
        const rawBody: string = await request.text();
        return (await deliver(rawBody, [...request.headers.entries()]))
          .response;
      }
      default:
        return text(`No route for ${route}.`, 404);
    }
  };

  const control: Handler = async (request: Request): Promise<Response> => {
    const url: URL = new URL(request.url);
    const route: string = `${request.method} ${url.pathname}`;
    switch (route) {
      case 'GET /':
        return text(
          'Live checks: /replay, /tamper (after a real webhook delivery) and /refresh (after an install).'
        );
      case 'GET /replay':
      case 'GET /tamper': {
        const captured: CapturedWebhook | undefined = state.captured;
        if (captured === undefined) {
          return text(
            'No verified webhook has been captured yet. Edit a product in the Shopify admin, wait for "POST /api/webhooks -> 200", then try again.',
            404
          );
        }
        const tamper: boolean = url.pathname === '/tamper';
        const { response, result } = await deliver(
          tamper ? `${captured.rawBody} ` : captured.rawBody,
          captured.headers
        );
        const passed: boolean = tamper
          ? response.status === 401
          : response.status === 200 &&
            result?.ok === true &&
            result.value.status === 'duplicate';
        const expected: string = tamper
          ? 'HTTP 401 (the signature covers the exact body)'
          : 'HTTP 200 and "duplicate" (acknowledged, handler not run again)';
        return text(
          `${tamper ? 'Tampered' : 'Replayed'} delivery: HTTP ${String(response.status)}, ${describeOutcome(result)}.\n` +
            `${passed ? 'PASS' : 'FAIL'}: expected ${expected}.`,
          passed ? 200 : 500
        );
      }
      case 'GET /refresh':
        return refresh(url, context, state.lastShop);
      default:
        return text(`No control route for ${route}.`, 404);
    }
  };

  return { app, control };
}

/** Routes a request to the public example handlers. */
export function createDevApp(context: AppContext): Handler {
  return createDevServer(context).app;
}

interface ShopName {
  readonly shop: { readonly name: string };
}

/** Refreshes the stored offline token, stores the new pair, and proves the new token works. */
async function refresh(
  url: URL,
  context: AppContext,
  lastShop: string | undefined
): Promise<Response> {
  const requested: string = url.searchParams.get('shop') ?? lastShop ?? '';
  const shop: Result<string, ConfigurationError> =
    normalizeShopDomain(requested);
  if (!shop.ok) {
    return text(
      `Say which shop to refresh: /refresh?shop=<store>. ${shop.error.message}`,
      400
    );
  }
  const stored: Result<Session | null> = await context.sessions.load(
    offlineSessionId(shop.value)
  );
  if (!stored.ok) return text(`FAIL: ${stored.error.message}`, 500);
  const before: Session | null = stored.value;
  if (before === null) {
    return text(`No session stored for ${shop.value}; install first.`, 404);
  }

  const refreshed: Result<Session> = await refreshSession(
    before,
    {
      clientId: context.config.clientId,
      clientSecret: context.config.clientSecret,
    },
    fetchOption(context)
  );
  if (!refreshed.ok) {
    return text(
      `FAIL: the refresh was refused: ${refreshed.error.message}`,
      502
    );
  }
  const after: Session = refreshed.value;
  const saved: Result<void> = await context.sessions.store(after);
  if (!saved.ok) return text(`FAIL: ${saved.error.message}`, 500);

  const lines: string[] = [
    `Refreshed the offline session for ${after.shop}.`,
    `- access token changed: ${after.accessToken === before.accessToken ? 'no' : 'yes'}`,
    `- refresh token rotated: ${after.refreshToken === before.refreshToken ? 'no' : 'yes'}`,
    `- new access token ${after.expiresAt === undefined ? 'does not expire' : `expires ${new Date(after.expiresAt).toISOString()}`}`,
  ];
  const client: Result<AdminClient> = createAdminClient({
    shop: after.shop,
    apiVersion: context.config.apiVersion,
    accessToken: after.accessToken,
    ...fetchOption(context),
  });
  if (!client.ok) {
    return text([...lines, `FAIL: ${client.error.message}`].join('\n'), 500);
  }
  const probe: Result<AdminResponse<ShopName>> =
    await client.value.request<ShopName>(
      'query DevRefreshShop { shop { name } }',
      {
        operationName: 'DevRefreshShop',
      }
    );
  if (!probe.ok) {
    return text(
      [
        ...lines,
        `FAIL: the new access token was rejected: ${probe.error.message}`,
      ].join('\n'),
      502
    );
  }
  const changed: boolean = after.accessToken !== before.accessToken;
  return text(
    [
      ...lines,
      `- new access token works: yes (shop "${probe.value.data.shop.name}")`,
      changed
        ? 'PASS: refreshed and the new token works.'
        : 'FAIL: Shopify returned the same access token.',
    ].join('\n'),
    changed ? 200 : 500
  );
}

async function toRequest(
  incoming: IncomingMessage,
  appUrl: string
): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  const hasBody: boolean =
    incoming.method !== 'GET' && incoming.method !== 'HEAD';
  const headers: Headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value !== undefined)
      headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return new Request(new URL(incoming.url ?? '/', appUrl), {
    method: incoming.method ?? 'GET',
    headers,
    ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
  });
}

async function sendResponse(
  response: Response,
  outgoing: ServerResponse
): Promise<void> {
  outgoing.statusCode = response.status;
  for (const [name, value] of response.headers) {
    if (name !== 'set-cookie') outgoing.setHeader(name, value);
  }
  const cookies: string[] = response.headers.getSetCookie();
  if (cookies.length > 0) outgoing.setHeader('set-cookie', cookies);
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

const entry: string | undefined = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const config: Result<AppConfig, ConfigurationError> = configFromEnv(
    process.env
  );
  if (!config.ok) {
    console.error(config.error.message);
    process.exit(1);
  }
  const sessions: SessionStorage = createMemorySessionStorage();
  const server: DevServer = createDevServer({
    config: config.value,
    sessions,
  });
  const port: number = Number(process.env['PORT'] ?? '3000');
  const controlPort: number = Number(process.env['DEV_CONTROL_PORT'] ?? '3001');
  const listen = (
    handler: Handler,
    baseUrl: string,
    listenPort: number,
    host: string | undefined,
    label: string
  ): void => {
    createServer(
      (incoming: IncomingMessage, outgoing: ServerResponse): void => {
        void (async (): Promise<void> => {
          try {
            const response: Response = await handler(
              await toRequest(incoming, baseUrl)
            );
            console.log(
              `${incoming.method ?? 'GET'} ${(incoming.url ?? '/').split('?')[0] ?? '/'} -> ${String(response.status)}`
            );
            await sendResponse(response, outgoing);
          } catch (thrown: unknown) {
            console.error(thrown);
            outgoing.statusCode = 500;
            outgoing.end('Internal error; see the server log.');
          }
        })();
      }
    ).listen(listenPort, host, () => {
      console.log(label);
    });
  };
  listen(
    server.app,
    config.value.appUrl,
    port,
    undefined,
    `Dev server on http://localhost:${String(port)}; public URL ${config.value.appUrl}`
  );
  // Loopback only, and a different port from the tunnel's: never public.
  listen(
    server.control,
    `http://127.0.0.1:${String(controlPort)}`,
    controlPort,
    '127.0.0.1',
    `Live-check routes on http://127.0.0.1:${String(controlPort)} (not tunneled): /replay /tamper /refresh`
  );
}
