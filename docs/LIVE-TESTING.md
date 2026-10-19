# Testing against a real shop

The test suite runs against mocked HTTP. It proves the library does what it
means to do, but only a real shop proves that Shopify answers the way the
library expects. Run this checklist on a development store before relying on
the library in production, and again after upgrading it.

Use a **development store**, never a merchant's shop. Everything below is
read-only except where noted.

## 1. Automated, read-only checks

```bash
export SHOPIFY_SHOP=your-dev-store          # or your-dev-store.myshopify.com
export SHOPIFY_API_VERSION=2026-10
export SHOPIFY_ADMIN_TOKEN=shpat_...        # an Admin API token for the shop
# optional: STOREFRONT_PUBLIC_TOKEN or STOREFRONT_PRIVATE_TOKEN, LIVE_BULK_QUERY
npm run live-check
```

It checks, in order: an Admin query, pagination, listing webhook
subscriptions, a bulk query with streamed results, and a Storefront query
(tokenless unless you give a token). Each step prints `PASS`, `FAIL` or `SKIP`
with the request ID of any failure, which is what Shopify support asks for.
The default bulk query reads product IDs and titles; set `LIVE_BULK_QUERY` for
something else. It needs `read_products` (or `write_products`, which includes
it).

The Storefront check needs the store's Online Store channel to be unlocked. On
a locked development store Shopify answers `400 "Online Store channel is
locked"`; that is the store, not the library, so skip the check or use a store
where the channel is available.

### Findings so far

- First live run (2026-10): the Admin shop query failed with `No operation named
"LiveShop"` because the client sent an `operationName` the query did not
  declare. Fixed: the name is now sent only when the document declares it.

## 2. Install flow (OAuth callback and token endpoint)

Needs a browser and a public HTTPS URL for your app (a tunnel such as
`cloudflared` or `ngrok` works).

1. Create an app in the Shopify Dev Dashboard. Set the redirect URL to
   `https://<your-url>/api/auth/callback` and note the client ID and secret.
2. Run the example routes (`examples/oauth.ts`, or `examples/next-app-router/`)
   with the environment variables listed in `examples/README.md`.
3. Open `https://<your-url>/api/auth/install?shop=<your-dev-store>` and approve.
4. **Expect** a redirect to your app, and a stored offline session with an
   access token, `expiresAt`, and a refresh token.

If the callback is rejected with `the "hmac" signature does not match`, the
signed string differs from what Shopify signed. Open an issue with the raw
query string (blank out `code` and `hmac`) and the client ID.

## 3. Embedded app: ID token and token exchange

Run the app inside the admin (the Shopify CLI's `shopify app dev` does this).
Call a route that uses `authenticateAdmin` from `examples/embedded.ts`.

**Expect** the first call to exchange the ID token for a token and store a
session, and later calls to reuse it. After the access token expires (about an
hour), **expect** a refresh, and a new refresh token in storage.

## 4. Webhooks

1. Subscribe: `syncWebhookSubscriptions(client, [{ topic: 'products/update', uri }])`
   with `uri` pointing at your public `/api/webhooks`.
2. Trigger a delivery: edit a product in the admin, or use the Shopify CLI's
   webhook trigger.
3. **Expect** `200` from your route and your handler to run once. Re-send the
   same delivery (replay it from Shopify's delivery log, or `curl` the captured
   request): **expect** `200` and no second handler run.
4. Send the captured request with one character of the body changed:
   **expect** `401`.

## 5. Bulk mutation (writes data)

Use a dev store. The mutation below adds a tag to products you choose, so it is
easy to undo.

```ts
const result = await runBulkMutation(
  client,
  `mutation TagProduct($tags: [String!]!, $id: ID!) {
     tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
   }`,
  [{ id: 'gid://shopify/Product/123', tags: ['bulk-test'] }]
);
```

**Expect** `COMPLETED`, a result URL, and the tag in the admin. This exercises
the staged upload, the multipart POST and the `stagedUploadPath` that the
library takes from the `key` parameter.

## Record

| Check                           | Date | Library version | API version | Result |
| ------------------------------- | ---- | --------------- | ----------- | ------ |
| Automated checks (`live-check`) |      |                 |             |        |
| Install flow                    |      |                 |             |        |
| Token exchange and refresh      |      |                 |             |        |
| Webhook delivery and replay     |      |                 |             |        |
| Bulk mutation                   |      |                 |             |        |
