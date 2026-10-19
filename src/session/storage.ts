import type { StorageError } from '../errors/errors.js';
import type { Result } from '../result/result.js';
import type { Session } from './session.js';

/**
 * Where sessions live between requests. Implementations return `Err` instead
 * of throwing. Treat the backing store as holding secrets: access tokens and
 * refresh tokens should be encrypted at rest and never logged.
 */
export interface SessionStorage {
  /** Resolves `null` when no session has this ID. */
  load(sessionId: string): Promise<Result<Session | null, StorageError>>;
  /** Creates or replaces the session with the same ID. */
  store(session: Session): Promise<Result<void, StorageError>>;
  /** Removing a session that does not exist is not an error. */
  delete(sessionId: string): Promise<Result<void, StorageError>>;
  /** Removes every session of a shop; call it when the app is uninstalled. */
  deleteByShop(shop: string): Promise<Result<void, StorageError>>;
}
