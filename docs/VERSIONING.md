# Versioning and Support Policy

## What is public API

Everything exported from the package root, `@richardmcquiston01/unofficial-shopify-api`,
is public: functions, classes, types and the `code` strings on errors. Deep
imports (`dist/...`) and anything not exported from the root are private and may
change in any release. The runtime export list is pinned by
`test/public-api.test.ts`; types are checked by `npm run verify`.

## Semantic versioning

From 1.0.0 the package follows [semver](https://semver.org/):

| Change                                                               | Release |
| -------------------------------------------------------------------- | ------- |
| Removing or renaming an export, or changing a signature incompatibly | major   |
| Changing an error `code`, or a `Result` shape callers rely on        | major   |
| Raising the minimum Node version (`engines`)                         | major   |
| Adding an export, an optional parameter, or a new error `code`       | minor   |
| Supporting a new Shopify API version                                 | minor   |
| Bug fixes, docs, performance, security hardening with no API change  | patch   |

Before 1.0 the same rules apply except that breaking changes may land in minor
releases, and each one is called out in the changelog.

Security fixes that must change behaviour (for example, refusing an input that
was previously accepted) ship as patch or minor releases with a clear changelog
entry, because leaving the hole open is worse than the break.

## Deprecation

1. The release that deprecates something marks it `@deprecated` in the types
   with the replacement, and notes it in the changelog.
2. It keeps working, unchanged, for at least one minor release and 90 days.
3. It is removed in the next major release, never in a minor.

## Shopify API versions

Shopify publishes a stable version each quarter (01, 04, 07, 10) and serves each
for 12 months. The library does not generate per-version types; `apiVersion` is
a string and `validateApiVersion` accepts any `YYYY-(01|04|07|10)` or
`unstable`, so a new Shopify version needs no code change to be used.

`api-versions.json` records the window we test and document against: the current
stable version and the three before it. `.github/workflows/api-version.yml`
checks weekly and opens a draft PR when a new version ships. That PR carries a
checklist: run the live check against the new version, read the release notes
for removed fields used by the bulk, webhook and user-error operations, and
update any pinned version in the examples.

If Shopify removes a field the library queries, the fix ships as a patch or
minor release for the versions that no longer work, with the minimum affected
version stated in the changelog.

## Runtime support

Node LTS lines only (`engines.node`, currently `>=22`). Dropping a Node line
after it leaves LTS is a major release. Bun, Deno, Cloudflare workerd and the
Vercel edge runtime are exercised on every CI run (`npm run test:runtimes`).

## Releasing 1.0

1.0.0 is gated on the manual live-store checklist in `docs/LIVE-TESTING.md`
passing on at least one supported API version. To cut it, add a changeset with
`major` for the package and follow [RELEASING.md](RELEASING.md): merge `dev` to
`main`, merge the "version packages" PR, then push the `v1.0.0` tag.
