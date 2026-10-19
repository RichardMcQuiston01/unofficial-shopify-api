import { ok, type Result } from '../result/result.js';
import type { StorageError } from '../errors/errors.js';
import type { Session } from './session.js';
import type { SessionStorage } from './storage.js';

/**
 * In-memory sessions for tests and single-process development. Everything is
 * lost on restart and nothing is shared between processes; use a durable
 * store in production.
 */
export function createMemorySessionStorage(): SessionStorage {
  const sessions: Map<string, Session> = new Map<string, Session>();
  return {
    load(sessionId: string): Promise<Result<Session | null, StorageError>> {
      return Promise.resolve(ok(sessions.get(sessionId) ?? null));
    },
    store(session: Session): Promise<Result<void, StorageError>> {
      sessions.set(session.id, session);
      return Promise.resolve(ok(undefined));
    },
    delete(sessionId: string): Promise<Result<void, StorageError>> {
      sessions.delete(sessionId);
      return Promise.resolve(ok(undefined));
    },
    deleteByShop(shop: string): Promise<Result<void, StorageError>> {
      for (const [id, session] of sessions) {
        if (session.shop === shop) sessions.delete(id);
      }
      return Promise.resolve(ok(undefined));
    },
  };
}
