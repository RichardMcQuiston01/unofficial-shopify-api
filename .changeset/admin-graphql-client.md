---
'@richardmcquiston01/unofficial-shopify-api': minor
---

Add `createAdminClient` for the Admin GraphQL API: typed `request()` returning
a `Result`, error mapping (HTTP, GraphQL `errors`, `userErrors`), cost-aware
throttle retries with backoff, per-attempt timeouts and `AbortSignal` support.
Also adds `checkUserErrors` and `HttpError`.
