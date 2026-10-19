import { describe, expect, it } from 'vitest';

import {
  WebhookVerificationError,
  verifyWebhook,
  type Result,
  type VerifiedWebhook,
} from '../src/index.js';
import { webhookHeaders, webhookSecret } from './webhook-helpers.js';

const body: string = JSON.stringify({ id: 1, title: 'Ünïcode ✓' });

async function rejection(
  request: Parameters<typeof verifyWebhook>[0]
): Promise<string> {
  const result: Result<VerifiedWebhook, WebhookVerificationError> =
    await verifyWebhook(request, webhookSecret);
  if (result.ok) throw new Error('Expected the webhook to be rejected.');
  expect(result.error).toBeInstanceOf(WebhookVerificationError);
  return result.error.message;
}

describe('verifyWebhook', () => {
  it('accepts a correctly signed delivery and exposes its metadata', async () => {
    const result: Result<VerifiedWebhook, WebhookVerificationError> =
      await verifyWebhook(
        {
          rawBody: body,
          headers: webhookHeaders(body, { 'X-Shopify-Name': 'sub-1' }),
        },
        webhookSecret
      );
    expect(result).toEqual({
      ok: true,
      value: {
        topic: 'products/update',
        shop: 'example.myshopify.com',
        webhookId: 'webhook-1',
        eventId: 'event-1',
        apiVersion: '2026-10',
        triggeredAt: '2026-10-19T00:00:00Z',
        subscriptionName: 'sub-1',
        rawBody: body,
        payload: { id: 1, title: 'Ünïcode ✓' },
      },
    });
  });

  it('works with bytes, a Headers object and lowercase header names', async () => {
    const lowered: Record<string, string> = Object.fromEntries(
      Object.entries(webhookHeaders(body)).map(
        ([key, value]: [string, string]): [string, string] => [
          key.toLowerCase(),
          value,
        ]
      )
    );
    const asBytes: Result<VerifiedWebhook, WebhookVerificationError> =
      await verifyWebhook(
        {
          rawBody: new TextEncoder().encode(body),
          headers: new Headers(lowered),
        },
        webhookSecret
      );
    expect(asBytes.ok && asBytes.value.payload).toEqual({
      id: 1,
      title: 'Ünïcode ✓',
    });
    const asRecord: Result<VerifiedWebhook, WebhookVerificationError> =
      await verifyWebhook({ rawBody: body, headers: lowered }, webhookSecret);
    expect(asRecord.ok).toBe(true);
  });

  it('accepts single-element array header values and ignores optional ones', async () => {
    const headers: Record<string, readonly string[]> = Object.fromEntries(
      Object.entries(webhookHeaders(body)).map(
        ([key, value]: [string, string]): [string, readonly string[]] => [
          key,
          [value],
        ]
      )
    );
    expect(
      (await verifyWebhook({ rawBody: body, headers }, webhookSecret)).ok
    ).toBe(true);
    const minimal: Result<VerifiedWebhook, WebhookVerificationError> =
      await verifyWebhook(
        {
          rawBody: body,
          headers: webhookHeaders(body, {
            'X-Shopify-Event-Id': undefined,
            'X-Shopify-API-Version': undefined,
            'X-Shopify-Triggered-At': undefined,
          }),
        },
        webhookSecret
      );
    expect(minimal.ok && minimal.value.eventId).toBeUndefined();
  });

  it('rejects a missing, repeated or malformed signature header', async () => {
    expect(
      await rejection({
        rawBody: body,
        headers: webhookHeaders(body, { 'X-Shopify-Hmac-Sha256': undefined }),
      })
    ).toContain('missing');
    expect(
      await rejection({
        rawBody: body,
        headers: {
          ...webhookHeaders(body),
          'X-Shopify-Hmac-Sha256': ['a', 'b'],
        },
      })
    ).toContain('missing');
    expect(
      await rejection({
        rawBody: body,
        headers: webhookHeaders(body, { 'X-Shopify-Hmac-Sha256': '***' }),
      })
    ).toContain('not valid base64');
  });

  it('rejects a body or secret that does not match the signature', async () => {
    expect(
      await rejection({ rawBody: `${body} `, headers: webhookHeaders(body) })
    ).toContain('does not match');
    expect(
      await rejection({
        rawBody: body,
        headers: webhookHeaders(body, {}, 'other-secret'),
      })
    ).toContain('does not match');
  });

  it('rejects an authentic delivery with missing or invalid routing headers', async () => {
    expect(
      await rejection({
        rawBody: body,
        headers: webhookHeaders(body, { 'X-Shopify-Topic': undefined }),
      })
    ).toContain('X-Shopify-Topic');
    expect(
      await rejection({
        rawBody: body,
        headers: webhookHeaders(body, { 'X-Shopify-Webhook-Id': '' }),
      })
    ).toContain('Webhook-Id');
    expect(
      await rejection({
        rawBody: body,
        headers: webhookHeaders(body, { 'X-Shopify-Shop-Domain': 'evil.com' }),
      })
    ).toContain('Shop-Domain');
  });

  it('rejects an authentic body that is not JSON', async () => {
    const xml: string = '<product><id>1</id></product>';
    expect(
      await rejection({ rawBody: xml, headers: webhookHeaders(xml) })
    ).toContain('not JSON');
  });
});
