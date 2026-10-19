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
  type AdminClient,
  type ConfigurationError,
  type Result,
  type Session,
  type SessionStorage,
  type SyncReport,
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
): Promise<void> {
  const location: string | null = response.headers.get('location');
  if (response.status !== 302 || location === null) return;
  const shopParam: string = new URL(location).searchParams.get('shop') ?? '';
  const stored: Result<Session | null> = await context.sessions.load(
    offlineSessionId(shopParam)
  );
  if (!stored.ok || stored.value === null) {
    console.log(`Installed ${shopParam}, but no session could be loaded.`);
    return;
  }
  const client: Result<AdminClient> = createAdminClient({
    shop: stored.value.shop,
    apiVersion: context.config.apiVersion,
    accessToken: stored.value.accessToken,
    ...fetchOption(context),
  });
  if (!client.ok) {
    console.log(`Could not create an Admin client: ${client.error.message}`);
    return;
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
}

/** Routes a request to the example handlers. */
export function createDevApp(context: AppContext): Handler {
  const webhooks: Handler = createWebhookHandler(context);
  return async (request: Request): Promise<Response> => {
    const url: URL = new URL(request.url);
    const route: string = `${request.method} ${url.pathname}`;
    switch (route) {
      case 'GET /':
        return home(url, context);
      case 'GET /api/auth/install':
        return beginInstall(request, context);
      case 'GET /api/auth/callback': {
        const response: Response = await finishInstall(request, context);
        await subscribeAfterInstall(response, context);
        return response;
      }
      case 'POST /api/webhooks':
        return webhooks(request);
      default:
        return text(`No route for ${route}.`, 404);
    }
  };
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
  const app: Handler = createDevApp({ config: config.value, sessions });
  const port: number = Number(process.env['PORT'] ?? '3000');
  createServer((incoming: IncomingMessage, outgoing: ServerResponse): void => {
    void (async (): Promise<void> => {
      try {
        const response: Response = await app(
          await toRequest(incoming, config.value.appUrl)
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
  }).listen(port, () => {
    console.log(
      `Dev server on http://localhost:${String(port)}; public URL ${config.value.appUrl}`
    );
  });
}
