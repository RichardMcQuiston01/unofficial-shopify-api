# Roadmap

Plan for `@richardmcquiston01/unofficial-shopify-api`: a framework-agnostic,
fully typed TypeScript client for Shopify's APIs, published to NPM.

## 1. Goals and Non-Goals

**Goals**

- Typed, ergonomic client for the Admin GraphQL, Storefront, and Webhook
  surfaces.
- Framework agnostic: runs on Node 20+, Next.js (Node and Edge), Vercel,
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
packages (optional, later):
  adapter-prisma  Prisma SessionStorage (separate entry point/package)
```

Key decisions

| Area         | Decision                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------- |
| Transport    | Native `fetch`; injectable for testing/proxies                                           |
| API version  | Explicit `apiVersion` (`YYYY-MM`), default to latest stable, documented support window   |
| Types        | `graphql-codegen` from Shopify schema, typed documents (`gql` tagged or `TypedDocument`) |
| Errors       | `Result<T, ShopifyError>`; subclasses for auth, throttle, user-error, network, schema    |
| Rate limits  | Read `extensions.cost` (GraphQL cost points); wait/retry on `THROTTLED`                  |
| Storage      | `SessionStorage` interface; Prisma adapter uses singular, snake_case tables, UUID PKs    |
| Style        | Google TypeScript Style Guide, Prettier (existing config), ESLint                        |

Prisma adapter schema (optional package): table `shopify_session` with UUID
`id`, `shop`, `access_token`, `scope`, `expires_at`, `created_at`,
`updated_at`.

## 3. Tooling

- **Build**: `tsup` (ESM + CJS + `.d.ts`), `exports` map in `package.json`.
- **Test**: Vitest; `msw` or fetch mocks for HTTP; coverage gate (>= 90%).
- **Lint/format**: ESLint (typescript-eslint, Google-style rules) + Prettier.
- **Type check**: `tsc --noEmit` with `strict`, `noUncheckedIndexedAccess`.
- **Package hygiene**: `publint`, `arethetypeswrong` in CI.
- **CI** (GitHub Actions): lint, typecheck, test on Node 20/22, build, pack
  check.
- **Release**: Changesets (or release-please) from Conventional Commits;
  publish with NPM provenance (`--provenance`) from CI on `main`; changelog
  in `CHANGELOG.md`.
- **Git flow**: per the repo `git-workflow` skill (`feature/*` -> `dev` ->
  `staging`/`main`, merge commits).
- **Docs**: TypeDoc API reference + README usage; docs site optional.

## 4. Milestones

### M0: Foundation (v0.0.x, ~1 week)

- [ ] Verify NPM package name / scope availability; create NPM org/token.
- [ ] `package.json`, `tsconfig`, tsup, Vitest, ESLint, Prettier wiring.
- [ ] CI workflow, issue/PR templates, CONTRIBUTING, SECURITY.md.
- [ ] `Result` type, error classes, logger interface.
- **Exit**: `npm run build && npm test` green in CI; empty package packs
  cleanly.

### M1: Core Admin GraphQL Client (v0.1.0, ~2 weeks)

- [ ] `createAdminClient({ shop, accessToken, apiVersion })`.
- [ ] `request(document, variables)` returning `Result`, typed via codegen.
- [ ] Error mapping (HTTP, GraphQL `errors`, `userErrors`).
- [ ] Rate-limit awareness: cost tracking, throttle retry/backoff, `Retry-After`.
- [ ] Unit + contract tests against recorded fixtures.
- **Exit**: can query/mutate products and orders against a dev store.

### M2: Auth and Sessions (v0.2.0, ~2 weeks)

- [ ] OAuth authorization-code flow (build URL, validate callback HMAC/state,
      exchange code).
- [ ] Token exchange flow for embedded apps; session-token JWT validation.
- [ ] `SessionStorage` interface + in-memory implementation.
- [ ] `adapter-prisma` package with migration and tests.
- **Exit**: end-to-end install flow demonstrated in an example Next.js app.

### M3: Webhooks (v0.3.0, ~1 week)

- [ ] Timing-safe HMAC verification over raw body (Web Crypto, edge-safe).
- [ ] Typed topic -> payload map; handler registry.
- [ ] Subscription registration/sync via GraphQL.
- **Exit**: verified webhooks processed in the example app.

### M4: Productivity Helpers (v0.4.0, ~2 weeks)

- [ ] Cursor pagination async iterators.
- [ ] Bulk operations (query + mutation), JSONL streaming parser.
- [ ] Storefront API client (public + private tokens).
- [ ] Idempotency / request-ID propagation, optional middleware hooks.

### M5: Hardening and Beta (v0.9.0, ~2 weeks)

- [ ] Runtime matrix tests: Node, Edge runtime, Workers, Bun.
- [ ] Bundle-size budget and dependency audit.
- [ ] Security review (secret handling, no token logging, HMAC edge cases).
- [ ] Complete docs, cookbook examples (Next.js, Hono, plain Node).
- [ ] Public beta; collect feedback.

### M6: 1.0.0

- [ ] Freeze public API, semver policy, deprecation policy.
- [ ] API-version support policy (track Shopify's quarterly releases; a
      scheduled workflow opens a PR when a new version ships).
- [ ] Announce (README, NPM, social).

### Post-1.0 Ideas

- Optional REST client, Customer Account API, Functions/Flow helpers.
- Mock server / test utilities for app developers.
- Additional storage adapters (Redis, Drizzle, Supabase).

## 5. Risks

| Risk                                       | Mitigation                                                          |
| ------------------------------------------ | ------------------------------------------------------------------- |
| Shopify API changes quarterly              | Codegen + scheduled version-bump PR; support last N versions        |
| Overlap with the official library          | Position on edge support, `Result` errors, size, typed docs         |
| Trademark ("Shopify" in name)              | Keep "unofficial" prefix and disclaimer in README; check guidelines |
| Security issues in auth/HMAC code          | Use Web Crypto, timing-safe compare, test vectors, security review  |
| Needing real stores for tests              | Dev store + recorded fixtures; live tests optional/manual in CI     |

## 6. Open Questions

1. Single package vs. monorepo (`core` + `adapter-prisma`)? Recommended:
   pnpm workspace once the Prisma adapter lands (M2).
2. Release tooling: Changesets vs. release-please?
3. Minimum Node version (recommended 20 LTS)?
4. Public apps, custom apps, or both as the primary target?
