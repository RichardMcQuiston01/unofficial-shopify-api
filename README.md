# @richardmcquiston01/unofficial-shopify-api

- Author: [Richard McQuiston](mailto:richard.mcquiston@gmail.com)
- Website: https://richardmcquiston.com/

## Table of Contents

| [Overview](#overview) | [Status](#status-and-runtime-support) | [Getting Started](#getting-started) | [Security](#security) | [Recommended Companions](#recommended-companions) | [Buy Me a Coffee](#buy-me-a-coffee) | [License](#license) | [Copyright](#copyright) |

## Overview

Framework agnostic TypeScript package for Shopify's API. This package will be incorporated into any projects for Shopify plugins.

[Back to Top](#table-of-contents)

## Status and Runtime Support

**1.0.** The public API follows [semver](https://semver.org/); see
[docs/VERSIONING.md](docs/VERSIONING.md) for what counts as public API, the
deprecation policy, and which Shopify API versions are supported. The library
covers the Admin and Storefront GraphQL APIs, OAuth and token exchange
(including expiring offline tokens and refresh), sessions, webhooks, pagination
and bulk operations.

It is tested with mocked HTTP on every change, and it has also been checked
against a real development store (API 2026-10): Admin queries, pagination,
bulk query and bulk mutation, webhook subscriptions, the OAuth install flow with
an expiring offline token, token refresh, and real webhook deliveries including
replay and tamper checks. Two paths are covered by tests only and have **not**
been verified against a real shop: the embedded app's ID-token exchange and the
Storefront API client. The full record, and how to repeat it on your own store
(`npm run live-check`), is in [docs/LIVE-TESTING.md](./docs/LIVE-TESTING.md).

The package has **no runtime dependencies** and uses only web-standard APIs
(`fetch`, Web Crypto, streams), so it runs where those exist. `npm run
test:runtimes` runs the same smoke checks against the built package in:

| Runtime                         | Notes                            |
| ------------------------------- | -------------------------------- |
| Node.js 22 and 24 (ESM and CJS) | The supported LTS lines          |
| Bun                             |                                  |
| Deno                            |                                  |
| Edge-runtime VM (Vercel Edge)   | No `process`, no `Buffer`        |
| Cloudflare `workerd` (Workers)  | Without the `nodejs_compat` flag |

Size, minified and gzipped, after tree-shaking: the whole library is about 13 KB;
importing only `verifyWebhook` costs about 2 KB, and `createAdminClient` about
4 KB. CI fails if these grow past a budget (`npm run check:bundle`).

[Back to Top](#table-of-contents)

## Getting Started

### Prerequisites

A current Node LTS (22 or newer), or any runtime with a standard `fetch`.

### Installation

```bash
npm install @richardmcquiston01/unofficial-shopify-api
```

### Usage

Every fallible call returns a `Result`: check `ok` before using the value.

```ts
import {
  checkUserErrors,
  createAdminClient,
  type AdminClient,
} from '@richardmcquiston01/unofficial-shopify-api';

const created = createAdminClient({
  shop: 'example', // or example.myshopify.com
  accessToken: process.env.SHOPIFY_ADMIN_TOKEN ?? '',
  apiVersion: '2026-10',
});
if (!created.ok) throw created.error; // descriptive configuration error
const client: AdminClient = created.value;

interface ShopData {
  shop: { name: string };
}
const result = await client.request<ShopData>('query { shop { name } }');
if (!result.ok) {
  console.error(result.error.code, result.error.message, result.error.context);
} else {
  console.log(result.value.data.shop.name, result.value.cost);
}
```

Throttled requests (HTTP 429 or GraphQL `THROTTLED`) are retried after the
wait Shopify implies. Network errors and 5xx responses are retried for
queries only, never for mutations, which may already have run. Mutation
validation failures arrive as `userErrors` inside a successful response; pass
the payload to `checkUserErrors` to turn them into an `Err`.

#### Authentication and sessions

Public apps need an access token per shop. Both flows end in a `Session` you
store and later pass to `createAdminClient`.

**Embedded apps (token exchange).** App Bridge gives the frontend a short-lived
ID token (formerly "session token"); send it to your backend, validate it, then
exchange it:

```ts
import {
  exchangeIdToken,
  sessionFromGrant,
  validateIdToken,
} from '@richardmcquiston01/unofficial-shopify-api';

const claims = await validateIdToken(idToken, { clientId, clientSecret });
if (!claims.ok) return respond401(); // App Bridge then fetches a fresh token

const grant = await exchangeIdToken({
  shop: claims.value.shop,
  clientId,
  clientSecret,
  idToken,
});
if (grant.ok) {
  await sessions.store(sessionFromGrant(claims.value.shop, grant.value));
}
```

**Standalone apps (authorization code).** Send the merchant to Shopify, verify the
callback, then exchange the code:

```ts
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  generateState,
  validateOAuthCallback,
} from '@richardmcquiston01/unofficial-shopify-api';

const state = generateState(); // save it (cookie or server session)
const url = buildAuthorizationUrl({
  shop,
  clientId,
  scopes: ['read_products'],
  redirectUri: 'https://app.example.com/auth/callback',
  state,
});

// In the callback route:
const callback = await validateOAuthCallback({
  query: request.url.search, // string, URLSearchParams or a parsed object
  clientSecret,
  expectedState: savedState,
});
if (callback.ok) {
  const grant = await exchangeAuthorizationCode({
    shop: callback.value.shop,
    clientId,
    clientSecret,
    code: callback.value.code,
  });
}
```

Public apps must use **expiring offline tokens** for the GraphQL Admin API
(required from 2027-01-01), so both exchanges request one by default. Such a
token lasts about an hour and comes with a 90-day refresh token. Check
`isAccessTokenExpired(session)` before use and call `refreshSession` when it is;
store the returned session, because every refresh issues a new refresh token.
Online tokens (`tokenType: 'online'`, or `perUser: true` for the code flow)
belong to one staff member, have no refresh token, and get a new ID-token
exchange instead.

**Storing sessions.** `SessionStorage` has four methods: `load`, `store`,
`delete` and `deleteByShop` (call it on app uninstall). `createMemorySessionStorage()`
is for tests. For anything durable, wrap a
[`storage-adapters`](https://github.com/RichardMcQuiston01/storage-adapters)
store (Postgres, MySQL, SQLite, Redis, ...) with `createKeyValueSessionStorage`:

```ts
const sessions = createKeyValueSessionStorage(myStorageAdapter);
```

Sessions hold access and refresh tokens. Encrypt them at rest (for example with
`withEncoding` from `storage-adapters`) and never log them.

#### Webhooks

Verify every delivery before trusting it, then dispatch by topic. Pass the
**raw** request body: the signature covers the exact bytes Shopify sent, so
re-serialized JSON will not verify.

```ts
import {
  createMemoryDeliveryLog,
  createWebhookRouter,
  ok,
  webhookResponseStatus,
} from '@richardmcquiston01/unofficial-shopify-api';

interface Payloads {
  'products/update': { id: number; title: string };
  'app/uninstalled': { domain: string };
}

const router = createWebhookRouter<Payloads>()
  .on('products/update', async (event) => {
    console.log(event.shop, event.payload.title);
    return ok(undefined);
  })
  .on('app/uninstalled', async (event) => {
    await sessions.deleteByShop(event.shop);
    return ok(undefined);
  });

const deliveryLog = createMemoryDeliveryLog(); // use a durable one when scaling out

// In your route handler (Fetch API shown):
const rawBody = await request.text();
const result = await router.handle(
  { rawBody, headers: request.headers },
  { clientSecret, deliveryLog }
);
return new Response(null, { status: webhookResponseStatus(result) });
```

A bad signature answers 401. A failed or throwing handler answers 500, which
makes Shopify retry, and the delivery is released so the retry is processed. A
retry of an already-handled delivery (same `X-Shopify-Webhook-Id`) is skipped.
Topics with no handler answer 200.

**Subscribing.** `syncWebhookSubscriptions(client, desired)` makes the shop's
API-created subscriptions match a list (create, update, leave alone), and only
deletes extras with `{ deleteExtra: true }`. Topics can be written as
`products/update` or `PRODUCTS_UPDATE`. It cannot see subscriptions declared in
`shopify.app.toml`; those are managed by Shopify and may be simpler for apps
that only need app-wide webhooks.

```ts
import { syncWebhookSubscriptions } from '@richardmcquiston01/unofficial-shopify-api';

const report = await syncWebhookSubscriptions(client, [
  { topic: 'products/update', uri: 'https://app.example.com/webhooks' },
  { topic: 'app/uninstalled', uri: 'https://app.example.com/webhooks' },
]);
```

#### Pagination

`paginate` walks a cursor-paginated connection page by page. The query declares
`$after: String` and passes it to the connection. After an `Err` the iteration
ends. `collectNodes` gathers everything into one array.

```ts
import {
  collectNodes,
  paginate,
} from '@richardmcquiston01/unofficial-shopify-api';

const query = `query Products($after: String) {
  products(first: 100, after: $after) {
    nodes { id title }
    pageInfo { hasNextPage endCursor }
  }
}`;
interface Data {
  products: {
    nodes: { id: string; title: string }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

for await (const page of paginate<Data, Data['products']['nodes'][number]>(
  client,
  query,
  {
    select: (data) => data.products,
  }
)) {
  if (!page.ok) return page; // stops here
  for (const product of page.value) console.log(product.title);
}
```

Both `nodes` and `edges { node }` are understood. A cursor that does not advance,
a missing connection, or more than `maxPages` (default 1000) pages is reported
as a `PaginationError` rather than looping.

#### Bulk operations

For large exports and imports use bulk operations. `runBulkQuery` starts one and
waits for it; `streamBulkResults` then reads the JSONL file line by line
without loading it into memory. Child rows carry the `__parentId` of their
parent.

```ts
import {
  runBulkQuery,
  streamBulkResults,
} from '@richardmcquiston01/unofficial-shopify-api';

const done = await runBulkQuery(
  client,
  `{ products { edges { node { id title variants { edges { node { id sku } } } } } } }`,
  { onProgress: (operation) => console.log(operation.objectCount) }
);
if (!done.ok) return done; // BulkOperationError carries status, errorCode, partialDataUrl

for await (const row of streamBulkResults(done.value.url)) {
  if (!row.ok) return row;
  console.log(row.value);
}
```

`runBulkMutation(client, mutation, rows)` uploads the variables (one JSON object
per line) to a staged upload, starts the mutation, and waits. The result file
is downloaded without your access token. Polling backs off from 2 to 10
seconds and gives up waiting after an hour by default (the operation keeps
running; `cancelBulkOperation` stops it). Subscribing to the
`bulk_operations/finish` webhook avoids polling.

#### Storefront API

```ts
import { createStorefrontClient } from '@richardmcquiston01/unofficial-shopify-api';

const created = createStorefrontClient({
  shop: 'example',
  apiVersion: '2026-10',
  privateAccessToken: storefrontPrivateToken, // a string from your secrets; server only
});
```

Use `publicAccessToken` for browsers and mobile apps, `privateAccessToken` for
servers (never ship it to a client), or neither for tokenless access to the
features that allow it. For requests that result from buyer traffic, pass the
buyer's address, `client.request(query, { buyerIp })`, so Shopify can tell
buyers apart for throttling and bot protection.

#### Tracing and metrics

Both clients accept `headers` (every request) and per-request `headers`, for
example `traceparent` or `X-Request-ID`. Credential and content headers cannot
be replaced. Every successful result has Shopify's `requestId`, and
`hooks.onAttempt` is called after each HTTP attempt, retries included, with the
operation, attempt number, duration, status and request ID:

```ts
createAdminClient({
  shop,
  apiVersion,
  accessToken,
  hooks: {
    onAttempt: (a) => metrics.timing('shopify', a.durationMs, { ok: a.ok }),
  },
});
```

### Examples

Runnable, type-checked handlers for OAuth, embedded apps, webhooks and bulk
exports live in [`examples/`](./examples), including Next.js App Router routes.

[Back to Top](#table-of-contents)

## Security

The library compares every signature in constant time, rejects empty secrets,
never follows redirects with credentials attached, never logs or quotes tokens,
and sends tokens only to `*.myshopify.com`. A review with its findings and
the things left to you (encrypting stored tokens, passing the raw webhook body,
replay handling) is in [docs/SECURITY-REVIEW.md](./docs/SECURITY-REVIEW.md).
Report vulnerabilities as described in [SECURITY.md](./SECURITY.md).

[Back to Top](#table-of-contents)

## Recommended Companions

This package has no runtime dependencies and does not bundle storage or
logging back ends. Two sibling packages by the same author fit it well; use
them if they suit your project.

| Package                                                                                            | Use it for                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`@richardmcquiston01/storage-adapters`](https://github.com/RichardMcQuiston01/storage-adapters)   | Persisting OAuth sessions and access tokens. It is an async key-value store with typed results and revisions, with adapters for Postgres, MySQL, SQLite, Redis, S3, Supabase, Firebase, files and browser storage. |
| [`@richardmcquiston01/error-log-adapter`](https://github.com/RichardMcQuiston01/error-log-adapter) | Routing failures to a sink of your choice (console, webhook, database, CloudWatch, SNS and more). Its `log()` never throws, which matches the `Result`-based errors here.                                          |

Every fallible call in this package returns a `Result`. Forward failures to
an error-log adapter where you handle them:

```ts
import { type Result } from '@richardmcquiston01/unofficial-shopify-api';
import { ConsoleErrorAdapter } from '@richardmcquiston01/error-log-adapter';

const errorLog: ConsoleErrorAdapter = new ConsoleErrorAdapter({
  prefix: '[shopify]',
});

async function logIfFailed<T>(result: Result<T>): Promise<void> {
  if (result.ok) return;
  await errorLog.log({
    code: result.error.code,
    message: result.error.message,
    cause: result.error,
    source: 'shopify',
  });
}
```

Session storage will be a small key-value interface (see the
[roadmap](./ROADMAP.md), milestone M2), so a `storage-adapters` store can sit
behind it in a few lines. Neither package is a dependency; install only what
you use.

[Back to Top](#table-of-contents)

## Buy Me a Coffee

If this app, code, or repository has helped you or someone you know, please consider donating. I appreciate any help to offset the costs of development and/or AI Credits.

[**Donate via PayPal**](https://www.paypal.com/ncp/payment/NENS5EGZLW5HA), or scan:

[![Donate via PayPal](./donate.png)](https://www.paypal.com/ncp/payment/NENS5EGZLW5HA)

[Back to Top](#table-of-contents)

## License

Apache 2

[Back to Top](#table-of-contents)

## Copyright

(c)2026 Richard McQuiston. All rights reserved.

[Back to Top](#table-of-contents)
