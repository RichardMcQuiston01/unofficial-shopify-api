/** Machine-readable error categories. */
export type ShopifyErrorCode =
  | 'CONFIGURATION'
  | 'NETWORK'
  | 'HTTP'
  | 'AUTHENTICATION'
  | 'THROTTLED'
  | 'GRAPHQL'
  | 'USER_ERROR'
  | 'WEBHOOK_VERIFICATION'
  | 'WEBHOOK_HANDLER'
  | 'PAGINATION'
  | 'BULK_OPERATION'
  | 'STORAGE';

/** Details that make an error traceable back to a specific request. */
export interface ShopifyErrorContext {
  /** Name of the operation or query that failed. */
  readonly operation?: string;
  /** Shop domain, e.g. `example.myshopify.com`. */
  readonly shop?: string;
  /** HTTP status code, when a response was received. */
  readonly status?: number;
  /** Value of Shopify's `X-Request-ID` header, for support requests. */
  readonly requestId?: string;
}

export interface ShopifyErrorOptions {
  readonly context?: ShopifyErrorContext;
  readonly cause?: unknown;
}

/** Base class for all errors produced by this library. */
export class ShopifyError extends Error {
  readonly code: ShopifyErrorCode;
  readonly context: ShopifyErrorContext;

  constructor(
    code: ShopifyErrorCode,
    message: string,
    options: ShopifyErrorOptions = {}
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.context = options.context ?? {};
  }
}

/** Invalid or missing client configuration (shop domain, token, version). */
export class ConfigurationError extends ShopifyError {
  constructor(message: string, options: ShopifyErrorOptions = {}) {
    super('CONFIGURATION', message, options);
  }
}

/** The request never produced a usable HTTP response. */
export class NetworkError extends ShopifyError {
  constructor(message: string, options: ShopifyErrorOptions = {}) {
    super('NETWORK', message, options);
  }
}

/**
 * Shopify answered with an unexpected HTTP status (404 unknown shop or API
 * version, 402 frozen shop, 5xx outage) or a body that is not valid JSON.
 */
export class HttpError extends ShopifyError {
  constructor(message: string, options: ShopifyErrorOptions = {}) {
    super('HTTP', message, options);
  }
}

/** Shopify rejected the credentials (HTTP 401/403) or a token was invalid. */
export class AuthenticationError extends ShopifyError {
  constructor(message: string, options: ShopifyErrorOptions = {}) {
    super('AUTHENTICATION', message, options);
  }
}

export interface ThrottledErrorOptions extends ShopifyErrorOptions {
  /** Suggested wait before retrying, in milliseconds. */
  readonly retryAfterMs?: number;
}

/** Rate limit or GraphQL cost limit exceeded. */
export class ThrottledError extends ShopifyError {
  readonly retryAfterMs: number | undefined;

  constructor(message: string, options: ThrottledErrorOptions = {}) {
    super('THROTTLED', message, options);
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** A single entry from a GraphQL response's top-level `errors` array. */
export interface GraphqlErrorDetail {
  readonly message: string;
  readonly path?: readonly (string | number)[];
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export interface GraphqlErrorOptions extends ShopifyErrorOptions {
  readonly errors: readonly GraphqlErrorDetail[];
}

/** The GraphQL response contained top-level `errors`. */
export class GraphqlError extends ShopifyError {
  readonly errors: readonly GraphqlErrorDetail[];

  constructor(message: string, options: GraphqlErrorOptions) {
    super('GRAPHQL', message, options);
    this.errors = options.errors;
  }
}

/** A single entry from a mutation payload's `userErrors`. */
export interface UserErrorDetail {
  readonly message: string;
  readonly field?: readonly string[] | null;
  readonly code?: string | null;
}

export interface UserErrorOptions extends ShopifyErrorOptions {
  readonly userErrors: readonly UserErrorDetail[];
}

/** A mutation was rejected by Shopify validation (`userErrors`). */
export class UserError extends ShopifyError {
  readonly userErrors: readonly UserErrorDetail[];

  constructor(message: string, options: UserErrorOptions) {
    super('USER_ERROR', message, options);
    this.userErrors = options.userErrors;
  }
}

/** A webhook signature was missing or did not match. */
export class WebhookVerificationError extends ShopifyError {
  constructor(message: string, options: ShopifyErrorOptions = {}) {
    super('WEBHOOK_VERIFICATION', message, options);
  }
}

/** A webhook handler failed or threw; Shopify should retry the delivery. */
export class WebhookHandlerError extends ShopifyError {
  constructor(message: string, options: ShopifyErrorOptions = {}) {
    super('WEBHOOK_HANDLER', message, options);
  }
}

/** Paging through a connection failed (missing connection, stuck cursor, page limit). */
export class PaginationError extends ShopifyError {
  constructor(message: string, options: ShopifyErrorOptions = {}) {
    super('PAGINATION', message, options);
  }
}

export interface BulkOperationErrorOptions extends ShopifyErrorOptions {
  readonly bulkOperationId: string;
  /** Final or last-seen status, such as `FAILED` or `CANCELED`. */
  readonly status: string;
  /** `ACCESS_DENIED`, `INTERNAL_SERVER_ERROR` or `TIMEOUT` for failed operations. */
  readonly errorCode: string | null;
  /** Partial results of a failed operation (JSONL), valid for 7 days. */
  readonly partialDataUrl: string | null;
}

/** A bulk operation did not complete: it failed, was canceled, expired or timed out waiting. */
export class BulkOperationError extends ShopifyError {
  readonly bulkOperationId: string;
  readonly status: string;
  readonly errorCode: string | null;
  readonly partialDataUrl: string | null;

  constructor(message: string, options: BulkOperationErrorOptions) {
    super('BULK_OPERATION', message, options);
    this.bulkOperationId = options.bulkOperationId;
    this.status = options.status;
    this.errorCode = options.errorCode;
    this.partialDataUrl = options.partialDataUrl;
  }
}

/** A session store could not read, write or decode a session. */
export class StorageError extends ShopifyError {
  constructor(message: string, options: ShopifyErrorOptions = {}) {
    super('STORAGE', message, options);
  }
}
