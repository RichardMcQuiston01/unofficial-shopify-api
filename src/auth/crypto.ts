/**
 * HMAC and encoding helpers built on Web Crypto, so they run on Node, edge
 * runtimes and browsers without dependencies.
 */

const encoder: TextEncoder = new TextEncoder();

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

/** Returns a fresh copy backed by a plain `ArrayBuffer`, as Web Crypto requires. */
function toBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

/** HMAC-SHA256 of `message` keyed with `secret`. */
export async function hmacSha256(
  secret: string,
  message: string | Uint8Array
): Promise<Uint8Array> {
  const key: CryptoKey = await importHmacKey(secret);
  const data: Uint8Array<ArrayBuffer> =
    typeof message === 'string' ? encoder.encode(message) : toBuffer(message);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

/**
 * Checks `signature` against HMAC-SHA256(`message`) in constant time, using
 * the platform's own verify rather than a hand-written comparison.
 */
export async function verifyHmac(
  secret: string,
  message: string | Uint8Array,
  signature: Uint8Array
): Promise<boolean> {
  const key: CryptoKey = await importHmacKey(secret);
  const data: Uint8Array<ArrayBuffer> =
    typeof message === 'string' ? encoder.encode(message) : toBuffer(message);
  return crypto.subtle.verify('HMAC', key, toBuffer(signature), data);
}

/**
 * Compares two strings without leaking where they first differ: both are
 * HMAC'd under a throwaway random key and the digests are verified by the
 * platform in constant time.
 */
export async function constantTimeEqual(
  left: string,
  right: string
): Promise<boolean> {
  const key: string = randomHex(32);
  return verifyHmac(key, left, await hmacSha256(key, right));
}

/** Decodes lowercase or uppercase hex; undefined if malformed. */
export function hexToBytes(hex: string): Uint8Array | undefined {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return undefined;
  }
  const bytes: Uint8Array = new Uint8Array(hex.length / 2);
  for (let index: number = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** Decodes standard or URL-safe base64, with or without padding; undefined if malformed. */
export function base64ToBytes(encoded: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(encoded)) return undefined;
  const standard: string = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded: string = standard.padEnd(
    standard.length + ((4 - (standard.length % 4)) % 4),
    '='
  );
  try {
    const binary: string = atob(padded);
    const bytes: Uint8Array = new Uint8Array(binary.length);
    for (let index: number = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return undefined;
  }
}

/** Decodes URL-safe base64 as UTF-8 text; undefined if malformed. */
export function base64UrlToText(encoded: string): string | undefined {
  const bytes: Uint8Array | undefined = base64ToBytes(encoded);
  if (bytes === undefined) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Cryptographically random lowercase hex string of `byteLength` bytes. */
export function randomHex(byteLength: number = 16): string {
  const bytes: Uint8Array = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (byte: number): string =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}
