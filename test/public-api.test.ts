import { describe, expect, it } from 'vitest';

import * as api from '../src/index.js';

/**
 * The runtime half of the frozen public API (see docs/VERSIONING.md). Adding
 * an export is a minor change and removing or renaming one is a major change,
 * so editing this list is always a deliberate act that shows up in review.
 * Types are covered by the attw and typecheck steps of `npm run verify`.
 */
const publicExports: readonly string[] = [
  'AuthenticationError',
  'BulkOperationError',
  'ConfigurationError',
  'GraphqlError',
  'HttpError',
  'NetworkError',
  'PaginationError',
  'ShopifyError',
  'StorageError',
  'ThrottledError',
  'UserError',
  'WebhookHandlerError',
  'WebhookVerificationError',
  'buildAuthorizationUrl',
  'canRefresh',
  'cancelBulkOperation',
  'checkUserErrors',
  'collectBulkResults',
  'collectNodes',
  'createAdminClient',
  'createConsoleLogger',
  'createGraphqlClient',
  'createKeyValueSessionStorage',
  'createMemoryDeliveryLog',
  'createMemorySessionStorage',
  'createStorefrontClient',
  'createWebhookRouter',
  'createWebhookSubscription',
  'deleteWebhookSubscription',
  'err',
  'exchangeAuthorizationCode',
  'exchangeIdToken',
  'fromGraphqlTopic',
  'generateState',
  'getBulkOperation',
  'isAccessTokenExpired',
  'listWebhookSubscriptions',
  'mapResult',
  'mergeHeaders',
  'noopLogger',
  'normalizeShopDomain',
  'offlineSessionId',
  'ok',
  'onlineSessionId',
  'paginate',
  'parseStoredSession',
  'refreshAccessToken',
  'refreshSession',
  'runBulkMutation',
  'runBulkQuery',
  'sessionFromGrant',
  'stageBulkMutationInput',
  'startBulkMutation',
  'startBulkQuery',
  'streamBulkResults',
  'syncWebhookSubscriptions',
  'toGraphqlTopic',
  'tryAsync',
  'updateWebhookSubscription',
  'validateApiVersion',
  'validateIdToken',
  'validateOAuthCallback',
  'validateWebhookUri',
  'verifyWebhook',
  'waitForBulkOperation',
  'webhookResponseStatus',
];

describe('public API surface', () => {
  it('exports exactly the documented runtime names', () => {
    expect(Object.keys(api).sort()).toEqual([...publicExports]);
  });
});
