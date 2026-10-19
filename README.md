# @richardmcquiston01/unofficial-shopify-api

- Author: [Richard McQuiston](mailto:richard.mcquiston@gmail.com)
- Website: https://richardmcquiston.com/

## Table of Contents

| [Overview](#overview) | [Getting Started](#getting-started) | [Recommended Companions](#recommended-companions) | [Buy Me a Coffee](#buy-me-a-coffee) | [License](#license) | [Copyright](#copyright) |

## Overview

Framework agnostic TypeScript package for Shopify's API. This package will be incorporated into any projects for Shopify plugins.

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

### Examples

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

[**Donate via Stripe**](https://donate.stripe.com/00w5kD3Gj1Xo9v7gVOcs800), or scan:

[![Donate via Stripe](./donate.svg)](https://donate.stripe.com/00w5kD3Gj1Xo9v7gVOcs800)

[Back to Top](#table-of-contents)

## License

Apache 2

[Back to Top](#table-of-contents)

## Copyright

(c)2026 Richard McQuiston. All rights reserved.

[Back to Top](#table-of-contents)
