import { StorageError } from '../errors/errors.js';
import { err, ok, type Result } from '../result/result.js';

/**
 * Remembers which deliveries were handled, so a retry of the same
 * `X-Shopify-Webhook-Id` is skipped. Use a durable, shared implementation
 * (database or Redis) when more than one process receives webhooks.
 *
 * A claim is made before the handler runs and released if it fails. If the
 * process dies mid-handler a durable log keeps the claim, so give claims an
 * expiry (a lease) or make handlers idempotent; otherwise Shopify's retry is
 * skipped as a duplicate.
 */
export interface DeliveryLog {
  /**
   * Atomically records the ID. Resolves true when this caller is first to
   * claim it, false when it was already claimed.
   */
  claim(webhookId: string): Promise<Result<boolean, StorageError>>;
  /** Forgets a claim after a failed handler, so Shopify's retry is processed. */
  release(webhookId: string): Promise<Result<void, StorageError>>;
}

export interface MemoryDeliveryLogOptions {
  /** How long an ID is remembered. Default 24 hours. */
  readonly ttlMs?: number;
  /** Oldest IDs are dropped past this many. Default 10000. */
  readonly maxEntries?: number;
  /** Clock in epoch milliseconds (for tests). */
  readonly now?: () => number;
}

/** In-process delivery log; lost on restart and not shared between processes. */
export function createMemoryDeliveryLog(
  options: MemoryDeliveryLogOptions = {}
): DeliveryLog {
  const ttlMs: number = options.ttlMs ?? 24 * 60 * 60 * 1000;
  const maxEntries: number = options.maxEntries ?? 10_000;
  const now: () => number = options.now ?? Date.now;
  const claimed: Map<string, number> = new Map<string, number>();

  function evict(): void {
    const cutoff: number = now() - ttlMs;
    for (const [id, claimedAt] of claimed) {
      // Map keeps insertion order, so the first live entry ends the sweep.
      if (claimedAt > cutoff && claimed.size <= maxEntries) break;
      claimed.delete(id);
    }
  }

  return {
    claim(webhookId: string): Promise<Result<boolean, StorageError>> {
      evict();
      if (claimed.has(webhookId)) return Promise.resolve(ok(false));
      if (webhookId === '') {
        return Promise.resolve(
          err(new StorageError('Cannot claim an empty webhook ID.'))
        );
      }
      claimed.set(webhookId, now());
      return Promise.resolve(ok(true));
    },
    release(webhookId: string): Promise<Result<void, StorageError>> {
      claimed.delete(webhookId);
      return Promise.resolve(ok(undefined));
    },
  };
}
