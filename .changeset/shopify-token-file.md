---
'@richardmcquiston01/unofficial-shopify-api': patch
---

The development-store token script saves its token to a git-ignored `.shopify-token` file, and the live checks read it when `SHOPIFY_ADMIN_TOKEN` is not set.
