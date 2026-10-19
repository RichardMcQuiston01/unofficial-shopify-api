# CHANGELOG

## 1.0.0

### Major Changes

- [#17](https://github.com/RichardMcQuiston01/unofficial-shopify-api/pull/17) [`cb6ad3c`](https://github.com/RichardMcQuiston01/unofficial-shopify-api/commit/cb6ad3c4619e15f0b6acb99988b594bf1a5dac07) Thanks [@RichardMcQuiston01](https://github.com/RichardMcQuiston01)! - First stable release. The public API is now covered by semantic versioning (see `docs/VERSIONING.md`).

  The library has been checked against a real Shopify development store on API 2026-10: Admin GraphQL queries, pagination, bulk query and bulk mutation, webhook subscriptions, the OAuth install flow with an expiring offline token, token refresh, and real webhook deliveries including replay and tamper checks. The embedded app's ID-token exchange and the Storefront API client are covered by tests only and have not yet been verified against a real shop.

### Minor Changes

- [#4](https://github.com/RichardMcQuiston01/unofficial-shopify-api/pull/4) [`d6b3d0c`](https://github.com/RichardMcQuiston01/unofficial-shopify-api/commit/d6b3d0cccffa47bb6a557eec9fe09339be65fdee) Thanks [@RichardMcQuiston01](https://github.com/RichardMcQuiston01)! - Add `createAdminClient` for the Admin GraphQL API: typed `request()` returning
  a `Result`, error mapping (HTTP, GraphQL `errors`, `userErrors`), cost-aware
  throttle retries with backoff, per-attempt timeouts and `AbortSignal` support.
  Also adds `checkUserErrors` and `HttpError`.

- [#5](https://github.com/RichardMcQuiston01/unofficial-shopify-api/pull/5) [`d461a9e`](https://github.com/RichardMcQuiston01/unofficial-shopify-api/commit/d461a9e98ca3c88d39c7e18ee2da38e1eb1e6686) Thanks [@RichardMcQuiston01](https://github.com/RichardMcQuiston01)! - Add authentication and sessions: `buildAuthorizationUrl`, `validateOAuthCallback`,
  `exchangeAuthorizationCode`, `validateIdToken`, `exchangeIdToken`,
  `refreshAccessToken`, the `Session` model with `refreshSession`, a
  `SessionStorage` interface, an in-memory implementation and
  `createKeyValueSessionStorage` for `storage-adapters`. Expiring offline tokens
  are requested by default. Adds `StorageError`.

- [#8](https://github.com/RichardMcQuiston01/unofficial-shopify-api/pull/8) [`b590fff`](https://github.com/RichardMcQuiston01/unofficial-shopify-api/commit/b590fff11feaf0559371a35e4a2e8f4fbd719d82) Thanks [@RichardMcQuiston01](https://github.com/RichardMcQuiston01)! - Add pagination (`paginate`, `collectNodes`), bulk operations (`runBulkQuery`,
  `runBulkMutation`, `startBulkQuery`, `startBulkMutation`, `stageBulkMutationInput`,
  `waitForBulkOperation`, `getBulkOperation`, `cancelBulkOperation`) with a
  streaming JSONL reader (`streamBulkResults`, `collectBulkResults`), and a
  Storefront API client (`createStorefrontClient`: public, private and tokenless
  access, buyer IP). The Admin and Storefront clients now share one engine
  (`createGraphqlClient`) and gain `headers` for tracing and an `onAttempt` hook.
  Adds `PaginationError` and `BulkOperationError`.

- [#7](https://github.com/RichardMcQuiston01/unofficial-shopify-api/pull/7) [`025e42d`](https://github.com/RichardMcQuiston01/unofficial-shopify-api/commit/025e42dee371799684eb791745deb3c6833a80dc) Thanks [@RichardMcQuiston01](https://github.com/RichardMcQuiston01)! - Add webhooks: `verifyWebhook` (base64 HMAC over the raw body, constant time),
  `createWebhookRouter` with typed handlers, duplicate skipping through a
  `DeliveryLog`, `webhookResponseStatus`, and subscription management
  (`list/create/update/deleteWebhookSubscription`, `syncWebhookSubscriptions`).
  Adds `WebhookHandlerError`.

### Patch Changes

- [#14](https://github.com/RichardMcQuiston01/unofficial-shopify-api/pull/14) [`89786cc`](https://github.com/RichardMcQuiston01/unofficial-shopify-api/commit/89786cc462d947e6e2a29b70b8df89cac82cb15d) Thanks [@RichardMcQuiston01](https://github.com/RichardMcQuiston01)! - Add a local `npm run dev-server` that mounts the example install and webhook handlers, so the live-testing steps can run against a real shop through a tunnel.

- [#6](https://github.com/RichardMcQuiston01/unofficial-shopify-api/pull/6) [`8e0d6e2`](https://github.com/RichardMcQuiston01/unofficial-shopify-api/commit/8e0d6e2b9b7927dcbd6f0cd94787028a6a6f565a) Thanks [@RichardMcQuiston01](https://github.com/RichardMcQuiston01)! - Add a `funding` link to package.json so `npm fund` and the npm page show the donate link.

- [#9](https://github.com/RichardMcQuiston01/unofficial-shopify-api/pull/9) [`cb1bac6`](https://github.com/RichardMcQuiston01/unofficial-shopify-api/commit/cb1bac6f27b5083b22527616fcbb142a46141b33) Thanks [@RichardMcQuiston01](https://github.com/RichardMcQuiston01)! - Hardening: an empty client secret now returns an error instead of throwing from
  the webhook, OAuth-callback and ID-token checks; GraphQL and token requests no
  longer follow redirects (a 3xx is reported as an `HttpError`); `verifyWebhook`
  and the webhook router accept `maxAgeSeconds` to limit replays. Exports
  `normalizeShopDomain` and `validateApiVersion`.

- [#12](https://github.com/RichardMcQuiston01/unofficial-shopify-api/pull/12) [`43b699e`](https://github.com/RichardMcQuiston01/unofficial-shopify-api/commit/43b699e803efc0319f2ffbd3fac07f0b01fd20f6) Thanks [@RichardMcQuiston01](https://github.com/RichardMcQuiston01)! - Add a write-guarded `npm run live-bulk-mutation` check and a PowerShell helper that fetches a development-store token, and document both in the live-testing guide.

- [#16](https://github.com/RichardMcQuiston01/unofficial-shopify-api/pull/16) [`199c3f7`](https://github.com/RichardMcQuiston01/unofficial-shopify-api/commit/199c3f7fd155568d0fee6b9817dc9a95cfe6ff21) Thanks [@RichardMcQuiston01](https://github.com/RichardMcQuiston01)! - Add loopback-only replay, tamper and token-refresh checks to the dev server so those behaviors can be confirmed against a real shop, and let the webhook example report each delivery's outcome.

- [#2](https://github.com/RichardMcQuiston01/unofficial-shopify-api/pull/2) [`12148a2`](https://github.com/RichardMcQuiston01/unofficial-shopify-api/commit/12148a26f85273450c491de236216433e533dbd3) Thanks [@RichardMcQuiston01](https://github.com/RichardMcQuiston01)! - Add project foundation: `Result` type, error classes and logger interface.

- [#10](https://github.com/RichardMcQuiston01/unofficial-shopify-api/pull/10) [`2f6a7af`](https://github.com/RichardMcQuiston01/unofficial-shopify-api/commit/2f6a7af7f41beeab88d165a9d7461cdad9cac87a) Thanks [@RichardMcQuiston01](https://github.com/RichardMcQuiston01)! - Document the semver, deprecation and Shopify API version policy, pin the public export list in a test, and add a weekly workflow that opens a PR when Shopify releases a new API version.

- [#11](https://github.com/RichardMcQuiston01/unofficial-shopify-api/pull/11) [`ea775ee`](https://github.com/RichardMcQuiston01/unofficial-shopify-api/commit/ea775eed31e7591c1f7294ba03286db7b47d836e) Thanks [@RichardMcQuiston01](https://github.com/RichardMcQuiston01)! - Only send `operationName` when the document declares an operation with that name. Shopify answers "No operation named ..." otherwise, which broke `paginate` (default name) and any call whose label differed from the query's name. The name is still used in errors and logs.

- [#13](https://github.com/RichardMcQuiston01/unofficial-shopify-api/pull/13) [`e4be015`](https://github.com/RichardMcQuiston01/unofficial-shopify-api/commit/e4be015eb006acc1b45f81b258398147ec36a61a) Thanks [@RichardMcQuiston01](https://github.com/RichardMcQuiston01)! - The development-store token script saves its token to a git-ignored `.shopify-token` file, and the live checks read it when `SHOPIFY_ADMIN_TOKEN` is not set.
