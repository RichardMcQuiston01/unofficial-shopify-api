# Roadmap

Plan for `@richardmcquiston01/unofficial-shopify-api`: a framework-agnostic,
fully typed TypeScript client for Shopify's APIs, published to NPM.

## 1. Goals and Non-Goals

**Goals**

- Typed, ergonomic client for the Admin GraphQL, Storefront, and Webhook
  surfaces.
- Framework agnostic: runs on current Node LTS, Next.js (Node and Edge), Vercel,
  Cloudflare Workers, and Bun/Deno. Uses the standard `fetch` API only.
- Zero (or near-zero) runtime dependencies.
- Predictable error handling: every fallible function returns a `Result`
  the caller must check; errors are descriptive (include operation, status,
  request ID, and Shopify error codes).
- Dual ESM + CJS output, bundled type declarations, tree-shakeable.

**Non-Goals (for 1.0)**

- Admin REST API wrapper (legacy; Shopify requires GraphQL for new public
  apps). Possible post-1.0 add-on if demand exists.
- UI components, Polaris, or App Bridge wrappers.
- Hosting or a CLI.

**Differentiation from `@shopify/shopify-api`**: smaller, edge-friendly,
`Result`-based errors, first-class codegen types, pluggable storage with a
Prisma adapter, no framework adapters baked in.

## 2. Architecture

```
src/
  client/         Admin + Storefront GraphQL clients (fetch transport)
  auth/           OAuth, token exchange, session-token (JWT) validation
  webhooks/       HMAC verification, topic typing, registration helpers
  rate-limit/     Cost-based throttle handling, retries with backoff
  pagination/     Cursor helpers (async iterators over connections)
  bulk/           Bulk operations (submit, poll, stream JSONL)
  session/        SessionStorage interface + in-memory implementation
  errors/         Error classes and Result<T, E> type
  types/          Generated + hand-written types
  index.ts        Public API surface
  adapters/
    prisma/       Prisma SessionStorage (subpath export, optional peer dep)
```

Single package: the Prisma adapter ships as the subpath export
`@richardmcquiston01/unofficial-shopify-api/prisma`. `@prisma/client` is an
optional peer dependency, so consumers who do not use Prisma install nothing
extra and the core entry point never imports it.

Key decisions

| Area        | Decision                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------- |
| Transport   | Native `fetch`; injectable for testing/proxies                                           |
| API version | Explicit `apiVersion` (`YYYY-MM`), default to latest stable, documented support window   |
| Types       | `graphql-codegen` from Shopify schema, typed documents (`gql` tagged or `TypedDocument`) |
| Errors      | `Result<T, ShopifyError>`; subclasses for auth, throttle, user-error, network, schema    |
| Rate limits | Read `extensions.cost` (GraphQL cost points); wait/retry on `THROTTLED`                  |
| Storage     | `SessionStorage` interface; Prisma adapter uses singular, snake_case tables, UUID PKs    |
| Style       | Google TypeScript Style Guide, Prettier (existing config), ESLint                        |

Prisma adapter schema (optional package): table `shopify_session` with UUID
`id`, `shop`, `access_token`, `scope`, `expires_at`, `created_at`,
`updated_at`.

## 3. Tooling

- **Build**: `tsup` (ESM + CJS + `.d.ts`), `exports` map in `package.json`.
- **Test**: Vitest; `msw` or fetch mocks for HTTP; coverage gate (>= 90%).
- **Lint/format**: ESLint (typescript-eslint, Google-style rules) + Prettier.
- **Type check**: `tsc --noEmit` with `strict`, `noUncheckedIndexedAccess`.
- **Package hygiene**: `publint`, `arethetypeswrong` in CI.
- **CI** (GitHub Actions): lint, typecheck, test on every supported Node LTS
  line, build, pack check.
- **Node support**: target Node LTS only. `engines.node` is set to the oldest
  LTS line still in Active/Maintenance support at release time, and the CI
  matrix covers each supported LTS line. Dropping an EOL LTS is a minor
  release, called out in the changeset.
- **Release**: Changesets. Each PR with a user-facing change includes a
  changeset (`npx changeset`); the Changesets GitHub Action opens a "Version
  Packages" PR, and merging it to `main` publishes with NPM provenance
  (`--provenance`) and updates `CHANGELOG.md`. Conventional Commits remain
  the commit convention.
- **Git flow**: per the repo `git-workflow` skill (`feature/*` -> `dev` ->
  `staging`/`main`, merge commits).
- **Docs**: TypeDoc API reference + README usage; docs site optional.

## 4. Milestones

### M0: Foundation (v0.0.x, ~1 week)

- [ ] Verify NPM package name / scope availability; create NPM org/token.
- [x] Configure Changesets and the release workflow.
- [x] Single-package `package.json` (with `exports` map), `tsconfig`, tsup, Vitest, ESLint, Prettier wiring.
- [x] CI workflow, issue/PR templates, CONTRIBUTING, SECURITY.md.
- [x] `Result` type, error classes, logger interface.
- **Exit**: `npm run build && npm test` green in CI; empty package packs
  cleanly.

### M1: Core Admin GraphQL Client (v0.1.0, ~2 weeks)

- [x] `createAdminClient({ shop, accessToken, apiVersion })`. `apiVersion` is
      required (no stale default); the shop must be a `.myshopify.com` host so
      tokens cannot be sent elsewhere.
- [x] `request(document, variables)` returning `Result`, typed via codegen.
- [x] Error mapping (HTTP, GraphQL `errors`, `userErrors`).
- [x] Rate-limit awareness: cost tracking, throttle retry/backoff, `Retry-After`.
- [x] Unit + contract tests against recorded fixtures.
- **Exit**: can query/mutate products and orders against a dev store.

### M2: Auth and Sessions (v0.2.0, ~2 weeks)

- [x] OAuth authorization-code flow (build URL, validate callback HMAC/state,
      exchange code).
- [x] Token exchange flow for embedded apps; session-token JWT validation.
- [x] `SessionStorage` interface + in-memory implementation.
- [x] `createKeyValueSessionStorage` bridge for `storage-adapters` (structural,
      no dependency); Prisma adapter deferred, since `storage-adapters` already
      covers Postgres, MySQL, SQLite and Redis.
- [x] Expiring offline tokens and refresh (`refreshSession`): public apps need
      them for the GraphQL Admin API from 2027-01-01.
- **Exit**: unit-tested flows (done); end-to-end install against a dev store and
  an example Next.js app still to do.

### M3: Webhooks (v0.3.0, ~1 week)

- [x] Timing-safe HMAC verification over raw body (Web Crypto, edge-safe).
- [x] Typed topic -> payload map; handler registry.
- [x] Subscription registration/sync via GraphQL.
- **Exit**: unit-tested flows (done); a real delivery from a dev store and the
  example app still to do.

### M4: Productivity Helpers (v0.4.0, ~2 weeks)

- [x] Cursor pagination async iterators (`paginate`, `collectNodes`).
- [x] Bulk operations (query + mutation, staged upload, polling, cancel) and a
      streaming JSONL result reader.
- [x] Storefront API client (public, private and tokenless access), on a
      shared GraphQL engine with the Admin client.
- [x] Request-ID propagation (client and per-request headers, `requestId` in
      results) and an `onAttempt` hook for logging and metrics.
- [ ] Idempotency keys for mutations (Shopify's `@idempotent` directive):
      deferred; needs checking against the supported API versions first.
- **Exit**: unit-tested (done); a real bulk query and Storefront request
  against a dev store still to do.

### M5: Hardening and Beta (v0.9.0, ~2 weeks)

- [x] Runtime matrix tests: Node 22/24 (ESM and CJS), Bun, Deno, an
      edge-runtime VM and `workerd` without `nodejs_compat`
      (`npm run test:runtimes`, a CI job).
- [x] Bundle-size budget (`npm run check:bundle`), a neutral-platform bundle
      check that fails on any Node-only import, and a no-dependencies check.
- [x] Security review (`docs/SECURITY-REVIEW.md`): three findings fixed with
      tests, plus a canary test that secrets never reach errors, logs or hooks.
- [x] Complete docs and cookbook examples (Next.js App Router, framework-agnostic
      handlers, bulk export), type-checked and exercised in tests.
- [x] Live-shop checklist (`docs/LIVE-TESTING.md`) and a read-only
      `npm run live-check`.
- [ ] **Run the live-shop checklist on a development store** (needs the owner).
- [ ] Public beta; collect feedback.

### M6: 1.0.0

- [ ] Live-shop checklist passed on at least one API version.
- [x] Freeze public API, semver policy, deprecation policy
      (`docs/VERSIONING.md`, `test/public-api.test.ts`).
- [x] API-version support policy (track Shopify's quarterly releases; a
      scheduled workflow opens a PR when a new version ships).
- [ ] Announce (README, NPM, social).

### Post-1.0 Ideas

- Optional REST client, Customer Account API, Functions/Flow helpers.
- Mock server / test utilities for app developers.
- Additional storage adapters (Redis, Drizzle, Supabase).

## 5. Risks

| Risk                              | Mitigation                                                          |
| --------------------------------- | ------------------------------------------------------------------- |
| Shopify API changes quarterly     | Codegen + scheduled version-bump PR; support last N versions        |
| Overlap with the official library | Position on edge support, `Result` errors, size, typed docs         |
| Trademark ("Shopify" in name)     | Keep "unofficial" prefix and disclaimer in README; check guidelines |
| Security issues in auth/HMAC code | Use Web Crypto, timing-safe compare, test vectors, security review  |
| Needing real stores for tests     | Dev store + recorded fixtures; live tests optional/manual in CI     |

## 6. Decisions

| Question         | Decision                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Package layout   | Single package; Prisma adapter is a subpath export with an optional peer dependency                                                  |
| Release tooling  | Changesets                                                                                                                           |
| Node support     | Node LTS lines only                                                                                                                  |
| Companion libs   | `storage-adapters` and `error-log-adapter` are recommended in the README, not bundled or depended on; the core stays zero-dependency |
| Target app types | Both public and custom apps; published publicly on NPM and also consumed by the author's own Shopify apps                            |

Implications of supporting both app types: auth covers OAuth/token exchange
(public apps) and static Admin API access tokens (custom apps); the public
API must stay stable and documented since external users depend on it, while
dogfooding in own projects drives the early API shape.
