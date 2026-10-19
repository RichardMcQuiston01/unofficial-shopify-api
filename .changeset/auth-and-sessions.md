---
'@richardmcquiston01/unofficial-shopify-api': minor
---

Add authentication and sessions: `buildAuthorizationUrl`, `validateOAuthCallback`,
`exchangeAuthorizationCode`, `validateIdToken`, `exchangeIdToken`,
`refreshAccessToken`, the `Session` model with `refreshSession`, a
`SessionStorage` interface, an in-memory implementation and
`createKeyValueSessionStorage` for `storage-adapters`. Expiring offline tokens
are requested by default. Adds `StorageError`.
