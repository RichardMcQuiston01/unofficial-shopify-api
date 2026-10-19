import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  StorageError,
  WebhookHandlerError,
  WebhookVerificationError,
  createMemoryDeliveryLog,
  createWebhookRouter,
  err,
  ok,
  webhookResponseStatus,
  type DeliveryLog,
  type Logger,
  type Result,
  type WebhookEvent,
  type WebhookHandler,
  type WebhookOutcome,
  type WebhookRouter,
} from '../src/index.js';
import { webhookHeaders, webhookSecret } from './webhook-helpers.js';

/* eslint-disable @typescript-eslint/naming-convention -- topics are slash-separated names. */
interface Payloads {
  readonly 'products/update': { readonly id: number };
  readonly 'app/uninstalled': { readonly domain: string };
}

/* eslint-enable @typescript-eslint/naming-convention */

const body: string = JSON.stringify({ id: 42 });
type HandleResult = Result<WebhookOutcome>;

function handle(
  router: WebhookRouter<Payloads>,
  extra: Partial<Parameters<WebhookRouter<Payloads>['handle']>[1]> = {},
  headers: Record<string, string | undefined> = {}
): Promise<HandleResult> {
  return router.handle(
    { rawBody: body, headers: webhookHeaders(body, headers) },
    { clientSecret: webhookSecret, ...extra }
  );
}

describe('createWebhookRouter', () => {
  it('dispatches a verified delivery to the typed handler', async () => {
    const seen: WebhookEvent<{ id: number }>[] = [];
    const router: WebhookRouter<Payloads> = createWebhookRouter<Payloads>().on(
      'products/update',
      (event: WebhookEvent<{ id: number }>) => {
        seen.push(event);
        return Promise.resolve(ok(undefined));
      }
    );

    const result: HandleResult = await handle(router);

    expect(result).toEqual({
      ok: true,
      value: {
        status: 'handled',
        topic: 'products/update',
        shop: 'example.myshopify.com',
        webhookId: 'webhook-1',
      },
    });
    expect(seen[0]?.payload.id).toBe(42);
  });

  it('runs several handlers for a topic in order and stops at the first failure', async () => {
    const calls: string[] = [];
    const router: WebhookRouter<Payloads> = createWebhookRouter<Payloads>()
      .on('products/update', () => {
        calls.push('first');
        return Promise.resolve(ok(undefined));
      })
      .on('products/update', () => {
        calls.push('second');
        return Promise.resolve(err(new Error('db down')));
      })
      .on('products/update', () => {
        calls.push('third');
        return Promise.resolve(ok(undefined));
      });
    const result: HandleResult = await handle(router);
    expect(calls).toEqual(['first', 'second']);
    expect(!result.ok && result.error).toBeInstanceOf(WebhookHandlerError);
    expect(!result.ok && result.error.message).toContain('db down');
    expect(!result.ok && result.error.message).toContain('webhook-1');
  });

  it('turns a thrown error into a WebhookHandlerError', async () => {
    const router: WebhookRouter<Payloads> = createWebhookRouter<Payloads>().on(
      'products/update',
      () => Promise.reject(new Error('boom'))
    );
    const result: HandleResult = await handle(router);
    expect(!result.ok && result.error.message).toContain('threw: boom');
    const stringThrower: WebhookRouter<Payloads> =
      createWebhookRouter<Payloads>().on(
        'products/update',
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- handlers may throw anything.
        () => Promise.reject('plain string')
      );
    expect(!(await handle(stringThrower)).ok).toBe(true);
  });

  it('reports topics without a handler as unhandled', async () => {
    const result: HandleResult = await handle(createWebhookRouter<Payloads>());
    expect(result.ok && result.value.status).toBe('unhandled');
  });

  it('rejects bad signatures before any handler runs', async () => {
    const handler: Mock<WebhookHandler> = vi.fn<WebhookHandler>(() =>
      Promise.resolve(ok(undefined))
    );
    const router: WebhookRouter<Payloads> = createWebhookRouter<Payloads>().on(
      'products/update',
      handler
    );
    const result: HandleResult = await router.handle(
      { rawBody: body, headers: webhookHeaders(body, {}, 'wrong') },
      { clientSecret: webhookSecret }
    );
    expect(!result.ok && result.error).toBeInstanceOf(WebhookVerificationError);
    expect(handler).not.toHaveBeenCalled();
    expect(webhookResponseStatus(result)).toBe(401);
  });

  it('skips duplicates, and lets a retry through after a failed handler', async () => {
    let shouldFail: boolean = true;
    const handler: Mock<WebhookHandler> = vi.fn<WebhookHandler>(() =>
      Promise.resolve(shouldFail ? err(new Error('try later')) : ok(undefined))
    );
    const router: WebhookRouter<Payloads> = createWebhookRouter<Payloads>().on(
      'products/update',
      handler
    );
    const deliveryLog: DeliveryLog = createMemoryDeliveryLog();

    const first: HandleResult = await handle(router, { deliveryLog });
    expect(first.ok).toBe(false);
    expect(webhookResponseStatus(first)).toBe(500);

    shouldFail = false;
    const retry: HandleResult = await handle(router, { deliveryLog });
    expect(retry.ok && retry.value.status).toBe('handled');

    const duplicate: HandleResult = await handle(router, { deliveryLog });
    expect(duplicate.ok && duplicate.value.status).toBe('duplicate');
    expect(webhookResponseStatus(duplicate)).toBe(200);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('does not claim deliveries that have no handler', async () => {
    const deliveryLog: DeliveryLog = createMemoryDeliveryLog();
    await handle(createWebhookRouter<Payloads>(), { deliveryLog });
    expect((await deliveryLog.claim('webhook-1')).ok).toBe(true);
    const claimedAgain: Result<boolean, StorageError> =
      await deliveryLog.claim('webhook-1');
    expect(claimedAgain.ok && claimedAgain.value).toBe(false);
  });

  it('fails the delivery when the delivery log is unavailable', async () => {
    const brokenLog: DeliveryLog = {
      claim: () => Promise.resolve(err(new StorageError('redis down'))),
      release: () => Promise.resolve(ok(undefined)),
    };
    const router: WebhookRouter<Payloads> = createWebhookRouter<Payloads>().on(
      'products/update',
      () => Promise.resolve(ok(undefined))
    );
    const result: HandleResult = await handle(router, {
      deliveryLog: brokenLog,
    });
    expect(!result.ok && result.error.message).toContain('redis down');
    expect(webhookResponseStatus(result)).toBe(500);
  });

  it('logs through the supplied logger without secrets', async () => {
    const lines: string[] = [];
    const record = (
      message: string,
      context?: Readonly<Record<string, unknown>>
    ): void => {
      lines.push(JSON.stringify([message, context]));
    };
    const router: WebhookRouter<Payloads> = createWebhookRouter<Payloads>().on(
      'products/update',
      () => Promise.resolve(err(new Error('nope')))
    );
    const logger: Logger = {
      debug: record,
      info: record,
      warn: record,
      error: record,
    };
    await handle(router, { logger });
    await router.handle(
      { rawBody: body, headers: webhookHeaders(body, {}, 'wrong') },
      { clientSecret: webhookSecret, logger }
    );
    await handle(createWebhookRouter<Payloads>(), { logger });
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.join('\n')).not.toContain(webhookSecret);
  });
});

describe('createMemoryDeliveryLog', () => {
  it('forgets IDs after the TTL and caps its size', async () => {
    let now: number = 0;
    const log: DeliveryLog = createMemoryDeliveryLog({
      ttlMs: 1000,
      maxEntries: 2,
      now: (): number => now,
    });
    expect((await log.claim('a')).ok).toBe(true);
    now = 500;
    const sameAgain: Result<boolean, StorageError> = await log.claim('a');
    expect(sameAgain.ok && sameAgain.value).toBe(false);
    now = 1501;
    const afterTtl: Result<boolean, StorageError> = await log.claim('a');
    expect(afterTtl.ok && afterTtl.value).toBe(true);

    await log.claim('b');
    await log.claim('c');
    const evicted: Result<boolean, StorageError> = await log.claim('a');
    expect(evicted.ok && evicted.value).toBe(true);
  });

  it('refuses an empty ID and tolerates releasing an unknown one', async () => {
    const log: DeliveryLog = createMemoryDeliveryLog();
    expect((await log.claim('')).ok).toBe(false);
    expect((await log.release('never-claimed')).ok).toBe(true);
  });
});

describe('webhookResponseStatus', () => {
  it('maps outcomes to HTTP statuses', () => {
    expect(
      webhookResponseStatus(
        ok({ status: 'handled', topic: 't', shop: 's', webhookId: 'w' })
      )
    ).toBe(200);
    expect(webhookResponseStatus(err(new WebhookVerificationError('x')))).toBe(
      401
    );
    expect(webhookResponseStatus(err(new WebhookHandlerError('x')))).toBe(500);
  });
});
