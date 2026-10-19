import type {
  AccessTokenGrant,
  AssociatedUser,
} from '../auth/token-endpoint.js';

/** One stored access token for a shop, and optionally the staff member it belongs to. */
export interface Session {
  /** `offline_<shop>` or `<shop>_<userId>`. See `offlineSessionId` and `onlineSessionId`. */
  readonly id: string;
  /** Normalized `example.myshopify.com`. */
  readonly shop: string;
  readonly isOnline: boolean;
  readonly accessToken: string;
  readonly scope: readonly string[];
  /** Epoch milliseconds; absent for a non-expiring token. */
  readonly expiresAt?: number;
  /** Expiring offline tokens only. Treat as a secret. */
  readonly refreshToken?: string;
  readonly refreshTokenExpiresAt?: number;
  /** Online tokens only. */
  readonly user?: AssociatedUser;
  readonly userScope?: readonly string[];
}

const defaultExpirySkewMs: number = 60_000;

/** ID of the shop-wide offline session. */
export function offlineSessionId(shop: string): string {
  return `offline_${shop}`;
}

/** ID of the online session of one staff member. */
export function onlineSessionId(shop: string, userId: number): string {
  return `${shop}_${String(userId)}`;
}

/** Builds a session from a token grant; online grants carry a user. */
export function sessionFromGrant(
  shop: string,
  grant: AccessTokenGrant
): Session {
  const user: AssociatedUser | undefined = grant.associatedUser;
  return {
    id:
      user === undefined
        ? offlineSessionId(shop)
        : onlineSessionId(shop, user.id),
    shop,
    isOnline: user !== undefined,
    accessToken: grant.accessToken,
    scope: grant.scope,
    ...(grant.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt }),
    ...(grant.refreshToken === undefined
      ? {}
      : { refreshToken: grant.refreshToken }),
    ...(grant.refreshTokenExpiresAt === undefined
      ? {}
      : { refreshTokenExpiresAt: grant.refreshTokenExpiresAt }),
    ...(user === undefined ? {} : { user }),
    ...(grant.associatedUserScope === undefined
      ? {}
      : { userScope: grant.associatedUserScope }),
  };
}

/**
 * True when the access token has expired or will within `skewMs` (default
 * 60 seconds), so a request never goes out with a token that lapses mid-flight.
 */
export function isAccessTokenExpired(
  session: Session,
  now: number = Date.now(),
  skewMs: number = defaultExpirySkewMs
): boolean {
  return session.expiresAt !== undefined && now >= session.expiresAt - skewMs;
}

/** True when a refresh token is stored and has not itself expired. */
export function canRefresh(
  session: Session,
  now: number = Date.now()
): boolean {
  return (
    session.refreshToken !== undefined &&
    (session.refreshTokenExpiresAt === undefined ||
      now < session.refreshTokenExpiresAt)
  );
}
