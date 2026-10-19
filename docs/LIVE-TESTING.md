# Testing against a real shop

The test suite runs against mocked HTTP. It proves the library does what it
means to do, but only a real shop proves that Shopify answers the way the
library expects. Run this checklist on a development store before relying on
the library in production, and again after upgrading it.

Use a **development store**, never a merchant's shop. Everything below is
read-only except where noted.

## 0. Getting an Admin token (Dev Dashboard apps)

For an app in your own organization, install it on the development store with
the scopes you need released on the app version, then trade its client ID and
secret for a 24-hour token (the client credentials grant). On Windows:

```powershell
.\scripts\get-shopify-token.ps1 -Shop your-dev-store -ClientId <client id>
```

It asks for the secret without echoing it, sets `SHOPIFY_SHOP`,
`SHOPIFY_API_VERSION` and `SHOPIFY_ADMIN_TOKEN` for that PowerShell session, and
runs `npm run live-check`. Add `-SkipLiveCheck` to only fetch the token. The
variables stay set afterwards, so the other commands below work in the same
window.

The token is also saved to `.shopify-token` in the project root (git-ignored,
plain text, valid for 24 hours; `-NoSaveToken` skips it). `npm run live-check`
and `npm run live-bulk-mutation` read it when `SHOPIFY_ADMIN_TOKEN` is not set,
so a new terminal only needs `SHOPIFY_SHOP` and `SHOPIFY_API_VERSION`. Delete
the file when you are done.

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

Needs a browser and a public HTTPS URL for your app. `npm run dev-server`
mounts the example handlers on `http://localhost:3000`, and a tunnel makes it
public.

1. Start the tunnel and note its address. With Cloudflare's quick tunnel (no
   account):

   ```powershell
   cloudflared tunnel --url http://localhost:3000
   ```

   It prints `https://<words>.trycloudflare.com`. The address changes each time
   the tunnel restarts.

2. In the Dev Dashboard, add `https://<tunnel-host>/api/auth/callback` to the
   app's redirect URLs (and set the App URL to `https://<tunnel-host>`), then
   release the app version so the change takes effect.
3. In a second terminal, set the app's settings and start the server:

   ```powershell
   $env:SHOPIFY_CLIENT_ID = "..."
   $env:SHOPIFY_CLIENT_SECRET = "..."
   $env:SHOPIFY_SCOPES = "read_products,write_products"
   $env:APP_URL = "https://<tunnel-host>"
   $env:SHOPIFY_API_VERSION = "2026-10"
   npm run dev-server
   ```

4. In a browser open `https://<tunnel-host>/api/auth/install?shop=<your-dev-store>`
   and approve.
5. **Expect** a redirect to `https://<tunnel-host>/?shop=<your-dev-store>`, a
   page saying the app is installed (it never shows the token), and these lines
   in the server log: `GET /api/auth/callback -> 302` and `Webhooks for
<shop>: 2 created, 0 unchanged.` The session lives in memory, so it is lost
   when the server stops.

If the callback is rejected with `the "hmac" signature does not match`, the
signed string differs from what Shopify signed. Open an issue with the raw
query string (blank out `code` and `hmac`) and the client ID.

## 3. Token refresh, and the embedded app's token exchange

**Refresh (no embedded app needed).** After the install in step 2, with the dev
server still running, open `http://127.0.0.1:3001/refresh` (a separate port on
loopback that the tunnel never reaches; set `DEV_CONTROL_PORT` to change it). It
refreshes the stored offline token with its refresh token, stores the new pair,
and calls the Admin API with the new access token. **Expect** `PASS`, with
"access token changed: yes", "refresh token rotated: yes" and "new access token
works: yes". It never prints a token. Add `?shop=<store>` if you installed more
than one.

**Embedded token exchange.** Run the app inside the admin (the Shopify CLI's
`shopify app dev` does this) and call a route that uses `authenticateAdmin` from
`examples/embedded.ts`. **Expect** the first call to exchange the ID token for a
token and store a session, and later calls to reuse it. The dev server does not
cover this, because the test app has to be embedded.

## 4. Webhooks

1. Subscribe: the install in step 2 already does this through the dev server
   (`app/uninstalled` and `products/update` to `<tunnel>/api/webhooks`). To do
   it yourself: `syncWebhookSubscriptions(client, [{ topic: 'products/update', uri }])`
   with `uri` pointing at your public `/api/webhooks`.
2. Trigger a delivery: edit a product in the admin, or use the Shopify CLI's
   webhook trigger. **Expect** `POST /api/webhooks -> 200` and a log line for the
   handler in the server window.
3. Replay: open `http://127.0.0.1:3001/replay`. It sends the last verified
   delivery through the handler again. **Expect** `PASS`: HTTP 200 and outcome
   `"duplicate"`, and no second handler line in the server log.
4. Tamper: open `http://127.0.0.1:3001/tamper`. It sends the same delivery with
   one extra character in the body. **Expect** `PASS`: HTTP 401, because the
   signature covers the exact bytes.

Only deliveries that pass verification are remembered, so a stranger's POST to
the public URL cannot replace the one `/replay` and `/tamper` use. The captured
body lives in memory only and is lost when the server stops.

## 5. Bulk mutation (writes data)

Use a dev store and a token with `write_products`. The check tags one product
through a bulk mutation, confirms the tag, then removes it. It refuses to run
until you opt in:

```bash
LIVE_ALLOW_WRITES=yes npm run live-bulk-mutation
```

```powershell
$env:LIVE_ALLOW_WRITES = "yes"
npm run live-bulk-mutation
```

Optional: `LIVE_PRODUCT_ID`, `LIVE_TAG` (default `bulk-test`), and
`LIVE_KEEP_TAG=yes` to leave the tag in place. It stops before writing if the
product already has the tag, so cleanup never removes a tag that was there
before.

**Expect** four `PASS` lines: choose a product, bulk mutation (a completed
operation and one result row with no user errors), verify, and cleanup. This
exercises the staged upload, the multipart POST and the `stagedUploadPath` that
the library takes from the `key` parameter.

## Record

| Check                               | Date       | Library version  | API version | Result                                                                                                                                                                                                                         |
| ----------------------------------- | ---------- | ---------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Automated checks (`live-check`)     | 2026-10-19 | unreleased (dev) | 2026-10     | Pass for the shop query, pagination, webhook listing and bulk query. Storefront failed: Online Store channel locked on the dev store.                                                                                          |
| Install flow                        | 2026-10-19 | unreleased (dev) | 2026-10     | Pass: callback signature and state check, code exchange, expiring offline token with a refresh token, webhook subscriptions created (via `npm run dev-server` and a Cloudflare quick tunnel).                                  |
| Token refresh                       | 2026-10-19 | unreleased (dev) | 2026-10     | Pass: the stored refresh token returned a new access token and a rotated refresh token, and the new access token worked on a live shop query.                                                                                  |
| Webhook delivery, replay and tamper | 2026-10-19 | unreleased (dev) | 2026-10     | Pass: a real `products/update` delivery verified and answered 200 (handler ran once); replaying it answered 200 as `duplicate` without running the handler again; the same body with one character added was refused with 401. |
| Bulk mutation                       | 2026-10-19 | unreleased (dev) | 2026-10     | Pass: staged upload, bulk mutation, tag verified, tag removed.                                                                                                                                                                 |
| Embedded token exchange             |            |                  |             | Not run: needs an embedded app (the test app is not embedded). Covered by tests only.                                                                                                                                          |
| Storefront query                    | 2026-10-19 | unreleased (dev) | 2026-10     | Not verified: the development store's Online Store channel is locked (HTTP 400). Covered by tests only.                                                                                                                        |
