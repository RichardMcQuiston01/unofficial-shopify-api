# 1.0 announcement drafts

Not part of the published package. Copy what you need. Everything below only
claims what has been verified; edit the numbers (size, test count) if they have
changed by release day.

## GitHub release notes / NPM release summary

**@richardmcquiston01/unofficial-shopify-api 1.0.0**

A framework-agnostic TypeScript client for Shopify's Admin and Storefront
GraphQL APIs, with no runtime dependencies.

- **Typed `Result` errors instead of thrown exceptions.** Every fallible call
  returns `{ ok, value }` or `{ ok, error }`, with an error class and a `code`
  that say what failed and where.
- **Runs where `fetch` and Web Crypto exist.** Node 22 and 24 (ESM and CJS), Bun,
  Deno, the Vercel edge runtime and Cloudflare Workers are exercised on every CI
  run. About 13 KB minified and gzipped for the whole library; importing only
  webhook verification costs about 2 KB.
- **Authentication:** OAuth authorization-code flow, ID-token validation and
  token exchange for embedded apps, expiring offline tokens and refresh, and a
  session model with pluggable storage.
- **Webhooks:** constant-time HMAC verification, replay protection, delivery
  de-duplication, a typed router, and subscription management.
- **Pagination and bulk operations:** async-iterator pagination, bulk queries
  and mutations with staged upload, and streamed JSONL results.
- **Semver from here.** See `docs/VERSIONING.md` for the deprecation policy and
  which Shopify API versions are supported. A weekly workflow opens a PR when
  Shopify ships a new version.

**Checked against a real store, not just mocks.** On a development store
(API 2026-10): Admin queries, pagination, bulk query and mutation, webhook
subscriptions, the OAuth install with an expiring offline token, token refresh,
and real webhook deliveries with replay and tamper checks. Not yet verified
against a real shop: the embedded ID-token exchange and the Storefront client
(covered by tests only). The record and the scripts to repeat it are in
`docs/LIVE-TESTING.md`.

This is an unofficial library and is not affiliated with or endorsed by Shopify.

```bash
npm install @richardmcquiston01/unofficial-shopify-api
```

## Short post (social)

Released 1.0 of my unofficial Shopify API client for TypeScript: Admin and
Storefront GraphQL, OAuth and token exchange, webhooks, pagination and bulk
operations. Zero dependencies, typed Result errors, runs on Node, Bun, Deno and
edge runtimes. Checked against a real dev store, with the unverified parts
listed in the repo.

npm i @richardmcquiston01/unofficial-shopify-api
https://github.com/RichardMcQuiston01/unofficial-shopify-api

## Medium post

I needed a Shopify client I could drop into any TypeScript project, including
edge runtimes, so I wrote one. 1.0 is out today.

What it is: a framework-agnostic client for the Admin and Storefront GraphQL
APIs with no runtime dependencies. It covers OAuth and token exchange (including
Shopify's expiring offline tokens), sessions, webhook verification and
routing, cursor pagination, and bulk operations with staged uploads.

What makes it different from the official library: errors come back as typed
`Result` values rather than exceptions, it only uses web-standard APIs so it runs
on Workers and the Vercel edge as well as Node, and it is small (about 13 KB for
everything; about 2 KB if you only verify webhooks).

How far I trust it: it runs against mocks on every change, and I also ran it
against a real development store on API 2026-10: queries, pagination, bulk
query and mutation, the OAuth install, token refresh, and real webhook
deliveries, including replaying a delivery and tampering with one. Two things
are covered by tests only so far: the embedded app token exchange and the
Storefront client. The repo lists exactly what was checked and how to repeat it
on your own store.

It is unofficial and not affiliated with Shopify.

npm i @richardmcquiston01/unofficial-shopify-api

## Checklist before publishing

- [ ] `@richardmcquiston01` scope ownership confirmed on NPM
- [ ] `dev` merged to `main` through a PR, "version packages" PR merged
- [ ] Release shows 1.0.0 on NPM with provenance
- [ ] Update the figures above if the bundle sizes or checks have changed
- [ ] Post the short text only after the package is live
