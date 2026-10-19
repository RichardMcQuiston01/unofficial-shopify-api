import {
  WebhookHandlerError,
  WebhookVerificationError,
  type ShopifyErrorContext,
  type StorageError,
} from '../errors/errors.js';
import { noopLogger, type Logger } from '../logger/logger.js';
import { err, ok, type Result } from '../result/result.js';
import type { DeliveryLog } from './delivery-log.js';
import {
  verifyWebhook,
  type VerifiedWebhook,
  type WebhookRequest,
} from './verify.js';

/**
 * Topic name → payload type, for typed handlers. Interfaces and type aliases
 * both work; the default accepts any topic with an `unknown` payload.
 */
export type WebhookPayloads = object;

type AnyTopics = Readonly<Record<string, unknown>>;

/** A verified delivery handed to a handler. */
export type WebhookEvent<TPayload = unknown> = VerifiedWebhook<TPayload>;

/**
 * Handlers return a `Result`. An `Err` (or a thrown error) makes the router
 * return a failure, so respond 5xx and Shopify retries the delivery.
 */
export type WebhookHandler<TPayload = unknown> = (
  event: WebhookEvent<TPayload>
) => Promise<Result<void, Error>>;

export interface HandleWebhookOptions {
  readonly clientSecret: string;
  /** See `VerifyWebhookOptions.maxAgeSeconds`. */
  readonly maxAgeSeconds?: number;
  /** Skips deliveries whose `X-Shopify-Webhook-Id` was already handled. */
  readonly deliveryLog?: DeliveryLog;
  readonly logger?: Logger;
}

/** What happened to a verified delivery. */
export interface WebhookOutcome {
  readonly status: 'handled' | 'duplicate' | 'unhandled';
  readonly topic: string;
  readonly shop: string;
  readonly webhookId: string;
}

export interface WebhookRouter<TPayloads extends WebhookPayloads = AnyTopics> {
  /** Registers a handler. Several handlers for one topic run in order. */
  on<TTopic extends keyof TPayloads & string>(
    topic: TTopic,
    handler: WebhookHandler<TPayloads[TTopic]>
  ): WebhookRouter<TPayloads>;
  /** Verifies, de-duplicates and dispatches one delivery. */
  handle(
    request: WebhookRequest,
    options: HandleWebhookOptions
  ): Promise<Result<WebhookOutcome>>;
}

/**
 * Creates a router. Give it a payload map to type handlers:
 * `createWebhookRouter<{ 'products/update': ProductPayload }>()`.
 */
export function createWebhookRouter<
  TPayloads extends WebhookPayloads = AnyTopics,
>(): WebhookRouter<TPayloads> {
  const handlers: Map<string, WebhookHandler[]> = new Map<
    string,
    WebhookHandler[]
  >();

  const router: WebhookRouter<TPayloads> = {
    on(
      topic: string,
      handler: WebhookHandler<never>
    ): WebhookRouter<TPayloads> {
      handlers.set(topic, [
        ...(handlers.get(topic) ?? []),
        handler as WebhookHandler,
      ]);
      return router;
    },
    async handle(
      request: WebhookRequest,
      options: HandleWebhookOptions
    ): Promise<Result<WebhookOutcome>> {
      const logger: Logger = options.logger ?? noopLogger;
      const verified: Result<WebhookEvent, WebhookVerificationError> =
        await verifyWebhook(request, options.clientSecret, {
          ...(options.maxAgeSeconds === undefined
            ? {}
            : { maxAgeSeconds: options.maxAgeSeconds }),
        });
      if (!verified.ok) {
        logger.warn('Webhook rejected', { reason: verified.error.message });
        return verified;
      }
      const event: WebhookEvent = verified.value;
      const outcome = (status: WebhookOutcome['status']): WebhookOutcome => ({
        status,
        topic: event.topic,
        shop: event.shop,
        webhookId: event.webhookId,
      });

      const matching: WebhookHandler[] | undefined = handlers.get(event.topic);
      if (matching === undefined || matching.length === 0) {
        logger.debug('No handler for webhook topic', { topic: event.topic });
        return ok(outcome('unhandled'));
      }

      if (options.deliveryLog !== undefined) {
        const claim: Result<boolean, StorageError> =
          await options.deliveryLog.claim(event.webhookId);
        if (!claim.ok) return claim;
        if (!claim.value) {
          logger.info('Skipping duplicate webhook', {
            webhookId: event.webhookId,
          });
          return ok(outcome('duplicate'));
        }
      }

      for (const handler of matching) {
        const failure: WebhookHandlerError | undefined = await runHandler(
          handler,
          event
        );
        if (failure !== undefined) {
          // Let the retry through: Shopify redelivers on a non-2xx answer.
          await options.deliveryLog?.release(event.webhookId);
          logger.error('Webhook handler failed', {
            topic: event.topic,
            webhookId: event.webhookId,
          });
          return err(failure);
        }
      }
      return ok(outcome('handled'));
    },
  };
  return router;
}

async function runHandler(
  handler: WebhookHandler,
  event: WebhookEvent
): Promise<WebhookHandlerError | undefined> {
  const context: ShopifyErrorContext = {
    operation: event.topic,
    shop: event.shop,
  };
  try {
    const result: Result<void, Error> = await handler(event);
    if (result.ok) return undefined;
    return new WebhookHandlerError(
      `Handler for ${event.topic} (delivery ${event.webhookId}) returned an error: ${result.error.message}`,
      { cause: result.error, context }
    );
  } catch (thrown: unknown) {
    const reason: string =
      thrown instanceof Error ? thrown.message : String(thrown);
    return new WebhookHandlerError(
      `Handler for ${event.topic} (delivery ${event.webhookId}) threw: ${reason}`,
      { cause: thrown, context }
    );
  }
}

/**
 * HTTP status to answer with: 200 for handled, duplicate and unhandled
 * deliveries; 401 for a bad signature; 500 for a failed handler or store,
 * so Shopify retries.
 */
export function webhookResponseStatus(result: Result<WebhookOutcome>): number {
  if (result.ok) return 200;
  return result.error instanceof WebhookVerificationError ? 401 : 500;
}
