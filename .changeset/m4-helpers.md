---
'@richardmcquiston01/unofficial-shopify-api': minor
---

Add pagination (`paginate`, `collectNodes`), bulk operations (`runBulkQuery`,
`runBulkMutation`, `startBulkQuery`, `startBulkMutation`, `stageBulkMutationInput`,
`waitForBulkOperation`, `getBulkOperation`, `cancelBulkOperation`) with a
streaming JSONL reader (`streamBulkResults`, `collectBulkResults`), and a
Storefront API client (`createStorefrontClient`: public, private and tokenless
access, buyer IP). The Admin and Storefront clients now share one engine
(`createGraphqlClient`) and gain `headers` for tracing and an `onAttempt` hook.
Adds `PaginationError` and `BulkOperationError`.
