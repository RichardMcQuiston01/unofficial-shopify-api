import {
  WebhookVerificationError,
  type ConfigurationError,
} from '../errors/errors.js';
import { normalizeShopDomain } from '../client/shop.js';
import { base64ToBytes, verifyHmac } from '../auth/crypto.js';
import { err, ok, type Result } from '../result/result.js';

/** Request headers as a `Headers` object or a plain (Node-style) record. */
export type HeadersLike =
  Headers | Readonly<Record<string, string | readonly string[] | undefined>>;

export interface WebhookRequest {
  /**
   * The exact bytes Shopify sent. Never pass re-serialized JSON: the
   * signature covers the original body, spaces and key order included.
   */
  readonly rawBody: string | Uint8Array;
  readonly headers: HeadersLike;
}

/** A delivery whose signature has been checked. */
export interface VerifiedWebhook<TPayload = unknown> {
  /** Header spelling, such as `products/update`. */
  readonly topic: string;
  /** Normalized `example.myshopify.com`. */
  readonly shop: string;
  /** Unique per delivery; use it to skip duplicates. */
  readonly webhookId: string;
  /** Shared by every delivery from the same merchant action. */
  readonly eventId: string | undefined;
  readonly apiVersion: string | undefined;
  readonly triggeredAt: string | undefined;
  /** The subscription `name`, when one was set. */
  readonly subscriptionName: string | undefined;
  readonly rawBody: string;
  readonly payload: TPayload;
}

const hmacHeader: string = 'x-shopify-hmac-sha256';

/** Case-insensitive single-value header lookup; repeated headers count as absent. */
function readHeader(headers: HeadersLike, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    if (typeof value === 'string') return value;
    return value !== undefined && value.length === 1 ? value[0] : undefined;
  }
  return undefined;
}

function reject(reason: string): Result<never, WebhookVerificationError> {
  return err(new WebhookVerificationError(`Webhook rejected: ${reason}.`));
}

/**
 * Verifies a delivery before anything in it is trusted: checks the
 * `X-Shopify-Hmac-Sha256` header (base64 HMAC-SHA256 of the raw body, compared
 * in constant time), then reads the routing headers and parses the JSON body.
 */
export async function verifyWebhook<TPayload = unknown>(
  request: WebhookRequest,
  clientSecret: string
): Promise<Result<VerifiedWebhook<TPayload>, WebhookVerificationError>> {
  const signatureHeader: string | undefined = readHeader(
    request.headers,
    hmacHeader
  );
  if (signatureHeader === undefined || signatureHeader === '') {
    return reject('the X-Shopify-Hmac-Sha256 header is missing');
  }
  const signature: Uint8Array | undefined = base64ToBytes(signatureHeader);
  if (signature === undefined) {
    return reject('the X-Shopify-Hmac-Sha256 header is not valid base64');
  }
  const bytes: Uint8Array =
    typeof request.rawBody === 'string'
      ? new TextEncoder().encode(request.rawBody)
      : request.rawBody;
  if (!(await verifyHmac(clientSecret, bytes, signature))) {
    return reject(
      'the signature does not match clientSecret. Check the secret, and that rawBody is the unparsed request body'
    );
  }

  const topic: string | undefined = readHeader(
    request.headers,
    'x-shopify-topic'
  );
  const webhookId: string | undefined = readHeader(
    request.headers,
    'x-shopify-webhook-id'
  );
  if (
    topic === undefined ||
    topic === '' ||
    webhookId === undefined ||
    webhookId === ''
  ) {
    return reject(
      'the signature is valid but X-Shopify-Topic or X-Shopify-Webhook-Id is missing'
    );
  }
  const shop: Result<string, ConfigurationError> = normalizeShopDomain(
    readHeader(request.headers, 'x-shopify-shop-domain') ?? ''
  );
  if (!shop.ok) {
    return reject(
      'X-Shopify-Shop-Domain is missing or not a .myshopify.com domain'
    );
  }

  const rawBody: string =
    typeof request.rawBody === 'string'
      ? request.rawBody
      : new TextDecoder().decode(request.rawBody);
  let payload: TPayload;
  try {
    payload = JSON.parse(rawBody) as TPayload;
  } catch {
    return reject(
      'the signature is valid but the body is not JSON (subscriptions must use format JSON)'
    );
  }
  return ok({
    topic,
    shop: shop.value,
    webhookId,
    eventId: readHeader(request.headers, 'x-shopify-event-id'),
    apiVersion: readHeader(request.headers, 'x-shopify-api-version'),
    triggeredAt: readHeader(request.headers, 'x-shopify-triggered-at'),
    subscriptionName: readHeader(request.headers, 'x-shopify-name'),
    rawBody,
    payload,
  });
}
