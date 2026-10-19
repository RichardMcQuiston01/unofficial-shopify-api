import { createHmac } from 'node:crypto';

export const webhookSecret: string = 'webhook-secret';

/** Signs the way Shopify does, independently of the library under test. */
export function webhookHeaders(
  body: string,
  overrides: Record<string, string | undefined> = {},
  secret: string = webhookSecret
): Record<string, string> {
  const headers: Record<string, string | undefined> = {
    'X-Shopify-Hmac-Sha256': createHmac('sha256', secret)
      .update(body)
      .digest('base64'),
    'X-Shopify-Topic': 'products/update',
    'X-Shopify-Shop-Domain': 'example.myshopify.com',
    'X-Shopify-Webhook-Id': 'webhook-1',
    'X-Shopify-Event-Id': 'event-1',
    'X-Shopify-API-Version': '2026-10',
    'X-Shopify-Triggered-At': '2026-10-19T00:00:00Z',
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(headers).filter(
      (entry: [string, string | undefined]): entry is [string, string] =>
        entry[1] !== undefined
    )
  );
}
