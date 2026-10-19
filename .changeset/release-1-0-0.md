---
'@richardmcquiston01/unofficial-shopify-api': major
---

First stable release. The public API is now covered by semantic versioning (see `docs/VERSIONING.md`).

The library has been checked against a real Shopify development store on API 2026-10: Admin GraphQL queries, pagination, bulk query and bulk mutation, webhook subscriptions, the OAuth install flow with an expiring offline token, token refresh, and real webhook deliveries including replay and tamper checks. The embedded app's ID-token exchange and the Storefront API client are covered by tests only and have not yet been verified against a real shop.
