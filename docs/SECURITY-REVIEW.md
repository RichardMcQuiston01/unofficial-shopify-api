# Security review (milestone 5)

This is a review of the library's own code by its author's tooling, not a
third-party audit. It covers where secrets flow, how signatures are checked, and
what the library sends where. Findings were fixed in the same change, each with
a test.

## Scope

Everything in `src/`: the GraphQL engine and Admin/Storefront clients, OAuth,
ID tokens, token grants, sessions, webhooks, pagination and bulk operations.
The package has **no runtime dependencies**, so its supply-chain surface is the
platform's `fetch`, Web Crypto and the build toolchain.

## Method

- Read every place a secret (access, refresh, client-secret, Storefront token)
  is received, stored or compared.
- Searched every `logger.*` call and every error message built from variables.
- Wrote a cross-cutting test that pushes a canary secret through each failure
  path (HTTP errors, retries, redirects, network failures, token grants,
  signature checks, storage failures) and asserts it never appears in an error
  message, an inspected error or its cause chain, a log line or a hook payload
  (`test/hardening.test.ts`).
- Reviewed regular expressions for catastrophic backtracking.
- Ran the code in Node, Bun, Deno, an edge-runtime VM and `workerd`
  (`npm run test:runtimes`).

## Findings and fixes

| #   | Finding                                                                                                                                                                                                                               | Fix                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | An **empty client secret** (typically an unset environment variable) made the webhook, OAuth-callback and ID-token checks throw `DataError` from Web Crypto instead of returning an `Err`, contradicting the "never throws" contract. | Entry points reject an empty secret with an error naming the likely cause; `verifyHmac` returns `false` for any unusable key. Tests for each entry point.                                      |
| 2   | `fetch` follows redirects by default, and custom headers such as `X-Shopify-Access-Token` (and a form body with the client secret) are not removed on a cross-origin redirect.                                                        | GraphQL and token-endpoint requests use `redirect: 'manual'`. A 3xx becomes an `HttpError` showing only the redirect's origin, and is not retried. Tests assert the option and the message.    |
| 3   | A captured, validly signed webhook could be replayed later: the HMAC does not cover time.                                                                                                                                             | Optional `maxAgeSeconds` on `verifyWebhook` and the router, checked against `X-Shopify-Triggered-At`. Off by default because Shopify retries failed deliveries for up to 48 hours. Documented. |

## Checked, no change needed

- **Constant-time comparison.** Webhook HMAC, OAuth-callback HMAC and ID-token
  signature use `crypto.subtle.verify`; the OAuth `state` uses
  `constantTimeEqual` (both values are HMAC'd under a random key and verified by
  the platform). No secret is compared with `===`. `aud` and shop names are not
  secrets.
- **Algorithm pinning.** ID tokens must declare `HS256`; `none` and other
  algorithms are rejected before any key is used.
- **Verify before parse.** Webhook bodies are parsed as JSON only after the
  signature is valid.
- **Token destinations.** Shops must be `*.myshopify.com`, so a token can never
  be sent to an arbitrary host. Result-file downloads and staged-upload POSTs
  carry no Shopify credentials.
- **Logging and errors.** Log contexts hold only shop, URL (no secrets), attempt,
  delay, code and status. Error messages quote at most 200 characters of
  Shopify's response body, collapse whitespace, and strip query strings (signed
  URLs) from download links.
- **Regular expressions.** Nested quantifiers use disjoint alternatives or are
  anchored; none backtrack catastrophically on adversarial input.
- **Prototype pollution.** Untrusted JSON is only read, never merged into
  objects; header merging uses `Object.fromEntries` over a `Map`.
- **Dependencies.** No runtime dependencies; `npm audit` reports nothing.

## Your responsibilities

The library cannot do these for you:

1. **Protect stored tokens.** Sessions hold access and refresh tokens in plain
   fields. Encrypt them at rest, and never `JSON.stringify` or log a session.
   `createKeyValueSessionStorage` stores them as given.
2. **Pass the raw body.** Webhook signatures cover the exact bytes; a body
   parsed and re-serialized will not verify.
3. **Keep the OAuth `state` per user agent.** Store it in an `HttpOnly`,
   `Secure`, `SameSite=Lax` cookie as in `examples/oauth.ts`, and use it once.
4. **Limit request sizes** in your web framework; the library reads what it is
   given.
5. **Treat replays as possible.** Use a durable delivery log (with expiring
   claims) and, if your handlers are not idempotent, `maxAgeSeconds`.
6. **Use only Shopify-provided URLs** with `streamBulkResults`; it downloads
   whatever HTTPS URL it is given.
7. **Rotate secrets deliberately.** After rotating the client secret Shopify
   may take up to an hour to sign with the new one; accept failures during that
   window.

## Reporting

See `SECURITY.md`.
