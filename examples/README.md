# Examples

Framework-agnostic handlers built on the web-standard `Request` and `Response`,
so they run in Next.js (App Router), Hono, Bun, Deno and Cloudflare Workers.
They are type-checked and linted with the library and exercised end to end by
`test/examples.test.ts`, so they stay working.

| File                    | What it shows                                                                                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.ts`                | Configuration from environment variables and the shared context (config + session store).                                                                                                                      |
| `oauth.ts`              | Standalone-app install: authorize URL, signed callback check, code exchange, stored session.                                                                                                                   |
| `embedded.ts`           | Embedded app: ID token check, token exchange, refresh of expiring offline tokens.                                                                                                                              |
| `webhooks.ts`           | A webhook route (verify, de-duplicate, dispatch) and subscribing with `sync`.                                                                                                                                  |
| `products.ts`           | Paging a connection, and exporting a catalog with a bulk operation streamed from disk.                                                                                                                         |
| `live-check.ts`         | Read-only smoke test against a real shop: `npm run live-check` (see `docs/LIVE-TESTING.md`).                                                                                                                   |
| `live-bulk-mutation.ts` | Tags one product through a bulk mutation, verifies it, removes the tag: `npm run live-bulk-mutation` (writes; needs `LIVE_ALLOW_WRITES=yes`).                                                                  |
| `dev-server.ts`         | A local server mounting the install and webhook handlers for live testing through a tunnel: `npm run dev-server` (testing only). A loopback-only second port runs the replay, tamper and token-refresh checks. |
| `next-app-router/`      | The same handlers mounted as Next.js route files.                                                                                                                                                              |

Environment variables used by `configFromEnv`: `SHOPIFY_CLIENT_ID`,
`SHOPIFY_CLIENT_SECRET`, `SHOPIFY_SCOPES` (comma separated), `APP_URL` and
`SHOPIFY_API_VERSION`.

Before deploying, replace `createMemorySessionStorage()` with a durable store,
for example `createKeyValueSessionStorage` over an adapter from
[`storage-adapters`](https://github.com/RichardMcQuiston01/storage-adapters),
and encrypt the tokens at rest.
