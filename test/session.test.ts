import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  AuthenticationError,
  canRefresh,
  createKeyValueSessionStorage,
  createMemorySessionStorage,
  isAccessTokenExpired,
  offlineSessionId,
  onlineSessionId,
  parseStoredSession,
  refreshSession,
  sessionFromGrant,
  type AccessTokenGrant,
  type KeyValueResult,
  type KeyValueStore,
  type Result,
  type Session,
  type SessionStorage,
  type StorageError,
} from '../src/index.js';
import { jsonResponse, omit } from './helpers.js';

const shop: string = 'example.myshopify.com';
const now: number = 1_760_000_000_000;

const offlineGrant: AccessTokenGrant = {
  accessToken: 'shpat_off',
  scope: ['read_products'],
  expiresAt: now + 3_600_000,
  refreshToken: 'shprt_1',
  refreshTokenExpiresAt: now + 7_776_000_000,
  associatedUser: undefined,
  associatedUserScope: undefined,
};

const onlineGrant: AccessTokenGrant = {
  accessToken: 'shpat_on',
  scope: ['read_products', 'write_orders'],
  expiresAt: now + 86_399_000,
  refreshToken: undefined,
  refreshTokenExpiresAt: undefined,
  associatedUser: { id: 7, firstName: 'Ada' },
  associatedUserScope: ['read_products'],
};

const offlineSession: Session = sessionFromGrant(shop, offlineGrant);
const onlineSession: Session = sessionFromGrant(shop, onlineGrant);
const withoutRefreshExpiry: Session = omit(
  offlineSession,
  'refreshTokenExpiresAt'
);
const withoutRefreshToken: Session = omit(offlineSession, 'refreshToken');

describe('sessions', () => {
  it('derives stable IDs', () => {
    expect(offlineSessionId(shop)).toBe('offline_example.myshopify.com');
    expect(onlineSessionId(shop, 7)).toBe('example.myshopify.com_7');
  });

  it('builds an offline session from a grant', () => {
    expect(offlineSession).toEqual({
      id: 'offline_example.myshopify.com',
      shop,
      isOnline: false,
      accessToken: 'shpat_off',
      scope: ['read_products'],
      expiresAt: now + 3_600_000,
      refreshToken: 'shprt_1',
      refreshTokenExpiresAt: now + 7_776_000_000,
    });
  });

  it('builds an online session keyed by user', () => {
    expect(onlineSession).toMatchObject({
      id: 'example.myshopify.com_7',
      isOnline: true,
      user: { id: 7, firstName: 'Ada' },
      userScope: ['read_products'],
    });
    expect('refreshToken' in onlineSession).toBe(false);
  });

  it('builds a session for a non-expiring token', () => {
    const session: Session = sessionFromGrant(shop, {
      ...offlineGrant,
      expiresAt: undefined,
      refreshToken: undefined,
      refreshTokenExpiresAt: undefined,
    });
    expect('expiresAt' in session).toBe(false);
    expect(isAccessTokenExpired(session, now + 10 ** 12)).toBe(false);
    expect(canRefresh(session, now)).toBe(false);
  });

  it('treats a token as expired 60 seconds early by default', () => {
    expect(isAccessTokenExpired(offlineSession, now)).toBe(false);
    expect(isAccessTokenExpired(offlineSession, now + 3_540_000)).toBe(true);
    expect(isAccessTokenExpired(offlineSession, now + 3_500_000)).toBe(false);
    expect(isAccessTokenExpired(offlineSession, now + 3_500_000, 200_000)).toBe(
      true
    );
    expect(isAccessTokenExpired(offlineSession)).toBe(true);
  });

  it('knows whether a refresh token is still usable', () => {
    expect(canRefresh(offlineSession, now)).toBe(true);
    expect(canRefresh(offlineSession, now + 7_776_000_000)).toBe(false);
    expect(canRefresh(withoutRefreshExpiry, now)).toBe(true);
    expect(canRefresh(onlineSession, now)).toBe(false);
  });
});

describe('createMemorySessionStorage', () => {
  it('loads, stores, deletes and deletes by shop', async () => {
    const storage: SessionStorage = createMemorySessionStorage();
    const other: Session = sessionFromGrant(
      'other.myshopify.com',
      offlineGrant
    );
    expect(await storage.load(offlineSession.id)).toEqual({
      ok: true,
      value: null,
    });
    await storage.store(offlineSession);
    await storage.store(onlineSession);
    await storage.store(other);
    expect(await storage.load(offlineSession.id)).toEqual({
      ok: true,
      value: offlineSession,
    });

    await storage.delete(onlineSession.id);
    expect((await storage.load(onlineSession.id)).ok).toBe(true);
    await storage.delete('missing');

    await storage.store(onlineSession);
    await storage.deleteByShop(shop);
    expect(await storage.load(offlineSession.id)).toEqual({
      ok: true,
      value: null,
    });
    expect(await storage.load(onlineSession.id)).toEqual({
      ok: true,
      value: null,
    });
    expect(await storage.load(other.id)).toEqual({ ok: true, value: other });
  });
});

type FakeStore = KeyValueStore & {
  readonly data: Map<string, string>;
};

function fakeStore(overrides: Partial<KeyValueStore> = {}): FakeStore {
  const data: Map<string, string> = new Map<string, string>();
  return {
    data,
    get: (key: string): Promise<KeyValueResult<{ value: string } | null>> => {
      const value: string | undefined = data.get(key);
      return Promise.resolve({
        ok: true,
        value: value === undefined ? null : { value },
      });
    },
    set: (key: string, value: string): Promise<KeyValueResult<unknown>> => {
      data.set(key, value);
      return Promise.resolve({ ok: true, value: { value } });
    },
    remove: (key: string): Promise<KeyValueResult<unknown>> => {
      data.delete(key);
      return Promise.resolve({ ok: true, value: null });
    },
    list: (prefix: string): Promise<KeyValueResult<string[]>> =>
      Promise.resolve({
        ok: true,
        value: [...data.keys()].filter((key: string): boolean =>
          key.startsWith(prefix)
        ),
      }),
    ...overrides,
  };
}

function storageError(result: Result<unknown, StorageError>): string {
  if (result.ok) throw new Error('Expected an Err result.');
  expect(result.error.code).toBe('STORAGE');
  return result.error.message;
}

describe('createKeyValueSessionStorage', () => {
  it('round-trips sessions under a prefixed key', async () => {
    const store: FakeStore = fakeStore();
    const storage: SessionStorage = createKeyValueSessionStorage(store);
    expect(await storage.load(offlineSession.id)).toEqual({
      ok: true,
      value: null,
    });
    expect((await storage.store(offlineSession)).ok).toBe(true);
    expect([...store.data.keys()]).toEqual([
      'shopify-session:offline_example.myshopify.com',
    ]);
    expect(await storage.load(offlineSession.id)).toEqual({
      ok: true,
      value: offlineSession,
    });
    expect((await storage.delete(offlineSession.id)).ok).toBe(true);
    expect(store.data.size).toBe(0);
  });

  it('honors a custom key prefix', async () => {
    const store: FakeStore = fakeStore();
    await createKeyValueSessionStorage(store, { keyPrefix: 'app:' }).store(
      offlineSession
    );
    expect([...store.data.keys()][0]).toBe('app:offline_example.myshopify.com');
  });

  it('deleteByShop removes only that shop and skips corrupt entries', async () => {
    const store: FakeStore = fakeStore();
    const storage: SessionStorage = createKeyValueSessionStorage(store);
    const other: Session = sessionFromGrant(
      'other.myshopify.com',
      offlineGrant
    );
    await storage.store(offlineSession);
    await storage.store(onlineSession);
    await storage.store(other);
    store.data.set('shopify-session:garbage', '{not json');

    expect((await storage.deleteByShop(shop)).ok).toBe(true);

    expect([...store.data.keys()].sort()).toEqual([
      'shopify-session:garbage',
      'shopify-session:offline_other.myshopify.com',
    ]);
  });

  it('reports corrupt stored values by key', async () => {
    const store: FakeStore = fakeStore();
    store.data.set(
      'shopify-session:s1',
      JSON.stringify({ version: 2, session: {} })
    );
    const message: string = storageError(
      await createKeyValueSessionStorage(store).load('s1')
    );
    expect(message).toContain('shopify-session:s1');
    expect(message).toContain('not a valid session');
  });

  it('turns store failures and thrown errors into StorageError', async () => {
    const failing: KeyValueSessionStorageFailure = {
      ok: false,
      code: 'unavailable',
      error: 'database is down',
    };
    const store: FakeStore = fakeStore({
      get: () => Promise.resolve(failing),
      set: () => Promise.resolve(failing),
      remove: () => Promise.resolve(failing),
      list: () => Promise.resolve(failing),
    });
    const storage: SessionStorage = createKeyValueSessionStorage(store);
    expect(storageError(await storage.load('s1'))).toContain(
      'database is down'
    );
    expect(storageError(await storage.store(offlineSession))).toContain(
      'write'
    );
    expect(storageError(await storage.delete('s1'))).toContain('delete');
    expect(storageError(await storage.deleteByShop(shop))).toContain('list');

    const throwing: FakeStore = fakeStore({
      get: () => Promise.reject(new Error('boom')),
      set: () => Promise.reject(new Error('boom')),
      remove: () => Promise.reject(new Error('boom')),
      list: () => Promise.reject(new Error('boom')),
    });
    const throwingStorage: SessionStorage =
      createKeyValueSessionStorage(throwing);
    expect(storageError(await throwingStorage.load('s1'))).toContain('boom');
    expect(storageError(await throwingStorage.store(offlineSession))).toContain(
      'boom'
    );
    expect(storageError(await throwingStorage.delete('s1'))).toContain('boom');
    expect(storageError(await throwingStorage.deleteByShop(shop))).toContain(
      'boom'
    );
  });

  it('stops deleteByShop when a remove fails', async () => {
    const store: FakeStore = fakeStore();
    const storage: SessionStorage = createKeyValueSessionStorage({
      ...store,
      remove: () =>
        Promise.resolve({ ok: false, code: 'forbidden', error: 'read-only' }),
    });
    await storage.store(offlineSession);
    expect(storageError(await storage.deleteByShop(shop))).toContain(
      'read-only'
    );
  });

  it('explains missing optional methods', async () => {
    const base: FakeStore = fakeStore();
    const bare: KeyValueStore = {
      get: (key: string, options: { readonly signal: AbortSignal }) =>
        base.get(key, options),
      set: (
        key: string,
        value: string,
        options: { readonly signal: AbortSignal }
      ) => base.set(key, value, options),
    };
    const storage: SessionStorage = createKeyValueSessionStorage(bare);
    expect(storageError(await storage.delete('s1'))).toContain('remove()');
    expect(storageError(await storage.deleteByShop(shop))).toContain('list()');
  });
});

type KeyValueSessionStorageFailure = {
  readonly ok: false;
  readonly code: string;
  readonly error: string;
};

describe('parseStoredSession', () => {
  it.each([
    '',
    'null',
    '[]',
    '{"version":1}',
    '{"version":1,"session":{"id":1}}',
  ])('rejects %j', (text: string) => {
    expect(parseStoredSession(text)).toBeUndefined();
  });
});

describe('refreshSession', () => {
  const credentials: { clientId: string; clientSecret: string } = {
    clientId: 'client-1',
    clientSecret: 'secret',
  };

  it('replaces the session with a freshly issued token pair', async () => {
    const fetchMock: Mock<typeof fetch> = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        access_token: 'shpat_new',
        scope: 'read_products',
        expires_in: 3600,
        refresh_token: 'shprt_2',
        refresh_token_expires_in: 7_776_000,
      })
    );
    const result: Result<Session> = await refreshSession(
      offlineSession,
      credentials,
      { fetch: fetchMock, now: (): number => now }
    );
    expect(result.ok && result.value).toMatchObject({
      id: offlineSession.id,
      accessToken: 'shpat_new',
      refreshToken: 'shprt_2',
      expiresAt: now + 3_600_000,
    });
    const body: URLSearchParams = new URLSearchParams(
      fetchMock.mock.calls[0]?.[1]?.body as string
    );
    expect(body.get('refresh_token')).toBe('shprt_1');
  });

  it('passes Shopify failures through', async () => {
    const fetchMock: Mock<typeof fetch> = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }));
    const result: Result<Session> = await refreshSession(
      offlineSession,
      credentials,
      { fetch: fetchMock, now: (): number => now }
    );
    expect(!result.ok && result.error).toBeInstanceOf(AuthenticationError);
  });

  it('refuses online sessions and sessions without a usable refresh token', async () => {
    const fetchMock: Mock<typeof fetch> = vi.fn<typeof fetch>();
    const online: Result<Session> = await refreshSession(
      onlineSession,
      credentials,
      { fetch: fetchMock }
    );
    expect(!online.ok && online.error.message).toContain('exchangeIdToken');
    const expired: Result<Session> = await refreshSession(
      offlineSession,
      credentials,
      { fetch: fetchMock, now: (): number => now + 10 ** 13 }
    );
    expect(!expired.ok && expired.error.message).toContain(
      'authorization again'
    );
    const none: Result<Session> = await refreshSession(
      withoutRefreshToken,
      credentials,
      { fetch: fetchMock }
    );
    expect(!none.ok && none.error.message).toContain('no usable refresh token');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
