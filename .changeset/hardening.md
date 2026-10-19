---
'@richardmcquiston01/unofficial-shopify-api': patch
---

Hardening: an empty client secret now returns an error instead of throwing from
the webhook, OAuth-callback and ID-token checks; GraphQL and token requests no
longer follow redirects (a 3xx is reported as an `HttpError`); `verifyWebhook`
and the webhook router accept `maxAgeSeconds` to limit replays. Exports
`normalizeShopDomain` and `validateApiVersion`.
