import {
  createMemoryDeliveryLog,
  createWebhookRouter,
  ok,
  syncWebhookSubscriptions,
  webhookResponseStatus,
  type AdminClient,
  type DeliveryLog,
  type Result,
  type SyncReport,
  type WebhookEvent,
  type WebhookOutcome,
  type WebhookRouter,
} from '@richardmcquiston01/unofficial-shopify-api';
import type { AppContext } from './app.js';

/** Payload types for the topics this app handles. */
/* eslint-disable @typescript-eslint/naming-convention -- topics are slash-separated names. */
export interface Payloads {
  'app/uninstalled': { readonly myshopify_domain: string };
  'products/update': { readonly id: number; readonly title: string };
}
/* eslint-enable @typescript-eslint/naming-convention */

/** Builds the route handler: `POST /api/webhooks`. */
export function createWebhookHandler(
  context: AppContext
): (request: Request) => Promise<Response> {
  // One log for the process; use a database or Redis log when you run several instances.
  const deliveryLog: DeliveryLog = createMemoryDeliveryLog();

  const router: WebhookRouter<Payloads> = createWebhookRouter<Payloads>()
    .on(
      'app/uninstalled',
      async (event: WebhookEvent<Payloads['app/uninstalled']>) => {
        // The merchant removed the app: drop their tokens.
        return context.sessions.deleteByShop(event.shop);
      }
    )
    .on(
      'products/update',
      (event: WebhookEvent<Payloads['products/update']>) => {
        console.log(
          `${event.shop}: product ${String(event.payload.id)} is now "${event.payload.title}"`
        );
        return Promise.resolve(ok(undefined));
      }
    );

  return async (request: Request): Promise<Response> => {
    // The raw text, before any JSON parsing: the signature covers these exact bytes.
    const rawBody: string = await request.text();
    const result: Result<WebhookOutcome> = await router.handle(
      { rawBody, headers: request.headers },
      {
        clientSecret: context.config.clientSecret,
        deliveryLog,
        maxAgeSeconds: 48 * 3600,
      }
    );
    return new Response(null, { status: webhookResponseStatus(result) });
  };
}

/** Run once per shop after install (for example from the OAuth callback). */
export function subscribeToWebhooks(
  client: AdminClient,
  context: AppContext
): Promise<Result<SyncReport>> {
  const uri: string = `${context.config.appUrl}/api/webhooks`;
  return syncWebhookSubscriptions(client, [
    { topic: 'app/uninstalled', uri },
    { topic: 'products/update', uri },
  ]);
}
