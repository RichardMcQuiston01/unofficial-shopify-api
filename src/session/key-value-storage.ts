import { StorageError } from '../errors/errors.js';
import { err, ok, type Result } from '../result/result.js';
import type { Session } from './session.js';
import type { SessionStorage } from './storage.js';

/** Result shape of a key-value store, matching `@richardmcquiston01/storage-adapters`. */
export type KeyValueResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly error: string };

/**
 * The slice of `@richardmcquiston01/storage-adapters`' `StorageAdapter` that
 * session storage needs, declared structurally so this package does not
 * depend on it. Any `StorageAdapter` can be passed as is.
 */
export interface KeyValueStore {
  get(
    key: string,
    options: { readonly signal: AbortSignal }
  ): Promise<KeyValueResult<{ readonly value: string } | null>>;
  set(
    key: string,
    value: string,
    options: { readonly signal: AbortSignal }
  ): Promise<KeyValueResult<unknown>>;
  remove?(
    key: string,
    options: { readonly signal: AbortSignal }
  ): Promise<KeyValueResult<unknown>>;
  list?(
    prefix: string,
    options: { readonly signal: AbortSignal }
  ): Promise<KeyValueResult<string[]>>;
}

export interface KeyValueSessionStorageOptions {
  /** Prepended to every key, so sessions can share a store. Default `shopify-session:`. */
  readonly keyPrefix?: string;
  /** Abort a store call after this many milliseconds. Default 10000. */
  readonly timeoutMs?: number;
}

const storedVersion: number = 1;

/** Stored form of a session; the version allows later migrations. */
interface StoredSession {
  readonly version: number;
  readonly session: Session;
}

function describe(
  failure: { readonly code: string; readonly error: string },
  action: string,
  key: string
): StorageError {
  return new StorageError(
    `Could not ${action} session key "${key}": ${failure.error} (${failure.code}).`
  );
}

function thrownToError(
  thrown: unknown,
  action: string,
  key: string
): StorageError {
  const reason: string =
    thrown instanceof Error ? thrown.message : String(thrown);
  return new StorageError(
    `Could not ${action} session key "${key}": ${reason}.`,
    {
      cause: thrown,
    }
  );
}

/** Decodes a stored value; undefined when it is not a valid session. */
export function parseStoredSession(text: string): Session | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const stored: Partial<StoredSession> = parsed;
  const session: Partial<Session> | undefined = stored.session;
  if (
    stored.version !== storedVersion ||
    session === undefined ||
    typeof session.id !== 'string' ||
    typeof session.shop !== 'string' ||
    typeof session.isOnline !== 'boolean' ||
    typeof session.accessToken !== 'string' ||
    !Array.isArray(session.scope)
  ) {
    return undefined;
  }
  return session as Session;
}

/**
 * Session storage on any key-value store, such as a
 * `@richardmcquiston01/storage-adapters` adapter for Postgres, Redis or SQLite.
 * `deleteByShop` needs the store to implement `list`.
 */
export function createKeyValueSessionStorage(
  store: KeyValueStore,
  options: KeyValueSessionStorageOptions = {}
): SessionStorage {
  const keyPrefix: string = options.keyPrefix ?? 'shopify-session:';
  const timeoutMs: number = options.timeoutMs ?? 10_000;
  const keyFor = (sessionId: string): string => `${keyPrefix}${sessionId}`;
  const signal = (): { readonly signal: AbortSignal } => ({
    signal: AbortSignal.timeout(timeoutMs),
  });

  async function load(
    sessionId: string
  ): Promise<Result<Session | null, StorageError>> {
    const key: string = keyFor(sessionId);
    try {
      const result: KeyValueResult<{ readonly value: string } | null> =
        await store.get(key, signal());
      if (!result.ok) return err(describe(result, 'read', key));
      if (result.value === null) return ok(null);
      const session: Session | undefined = parseStoredSession(
        result.value.value
      );
      if (session === undefined) {
        return err(
          new StorageError(
            `Stored value for session key "${key}" is not a valid session (corrupt or from a newer version).`
          )
        );
      }
      return ok(session);
    } catch (thrown: unknown) {
      return err(thrownToError(thrown, 'read', key));
    }
  }

  async function storeSession(
    session: Session
  ): Promise<Result<void, StorageError>> {
    const key: string = keyFor(session.id);
    const value: string = JSON.stringify({ version: storedVersion, session });
    try {
      const result: KeyValueResult<unknown> = await store.set(
        key,
        value,
        signal()
      );
      return result.ok ? ok(undefined) : err(describe(result, 'write', key));
    } catch (thrown: unknown) {
      return err(thrownToError(thrown, 'write', key));
    }
  }

  async function remove(key: string): Promise<Result<void, StorageError>> {
    if (store.remove === undefined) {
      return err(
        new StorageError(
          `Cannot delete session key "${key}": the store has no remove() method.`
        )
      );
    }
    try {
      const result: KeyValueResult<unknown> = await store.remove(key, signal());
      return result.ok ? ok(undefined) : err(describe(result, 'delete', key));
    } catch (thrown: unknown) {
      return err(thrownToError(thrown, 'delete', key));
    }
  }

  async function deleteByShop(
    shop: string
  ): Promise<Result<void, StorageError>> {
    if (store.list === undefined) {
      return err(
        new StorageError(
          `Cannot delete the sessions of ${shop}: the store has no list() method.`
        )
      );
    }
    let keys: KeyValueResult<string[]>;
    try {
      keys = await store.list(keyPrefix, signal());
    } catch (thrown: unknown) {
      return err(thrownToError(thrown, 'list', keyPrefix));
    }
    if (!keys.ok) return err(describe(keys, 'list', keyPrefix));
    for (const key of keys.value) {
      const loaded: Result<Session | null, StorageError> = await load(
        key.slice(keyPrefix.length)
      );
      // A corrupt entry cannot be tied to a shop; leave it for the operator.
      if (!loaded.ok || loaded.value === null || loaded.value.shop !== shop)
        continue;
      const removed: Result<void, StorageError> = await remove(key);
      if (!removed.ok) return removed;
    }
    return ok(undefined);
  }

  return {
    load,
    store: storeSession,
    delete: (sessionId: string): Promise<Result<void, StorageError>> =>
      remove(keyFor(sessionId)),
    deleteByShop,
  };
}
