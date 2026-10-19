---
'@richardmcquiston01/unofficial-shopify-api': minor
---

Add webhooks: `verifyWebhook` (base64 HMAC over the raw body, constant time),
`createWebhookRouter` with typed handlers, duplicate skipping through a
`DeliveryLog`, `webhookResponseStatus`, and subscription management
(`list/create/update/deleteWebhookSubscription`, `syncWebhookSubscriptions`).
Adds `WebhookHandlerError`.
