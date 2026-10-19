---
'@richardmcquiston01/unofficial-shopify-api': patch
---

Only send `operationName` when the document declares an operation with that name. Shopify answers "No operation named ..." otherwise, which broke `paginate` (default name) and any call whose label differed from the query's name. The name is still used in errors and logs.
