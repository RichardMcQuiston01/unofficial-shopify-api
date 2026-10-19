import type { Logger } from '../logger/logger.js';

/** GraphQL variables for a request. */
export type GraphqlVariables = Readonly<Record<string, unknown>>;

/**
 * A GraphQL document that carries its result and variable types, such as the
 * `TypedDocumentString` emitted by GraphQL Code Generator's client preset.
 */
export interface TypedDocument<
  TData = unknown,
  TVariables extends GraphqlVariables = GraphqlVariables,
> {
  // Name fixed by GraphQL Code Generator's TypedDocumentString.
  // eslint-disable-next-line @typescript-eslint/naming-convention
  readonly __apiType?: (variables: TVariables) => TData;
  toString(): string;
}

/** Either a plain query string or a typed document. */
export type GraphqlDocument<
  TData = unknown,
  TVariables extends GraphqlVariables = GraphqlVariables,
> = string | TypedDocument<TData, TVariables>;

/** Shopify's GraphQL rate limit bucket for the shop and app. */
export interface ThrottleStatus {
  readonly maximumAvailable: number;
  readonly currentlyAvailable: number;
  /** Points restored per second. */
  readonly restoreRate: number;
}

/** Query cost reported in `extensions.cost`. */
export interface QueryCost {
  readonly requestedQueryCost: number;
  readonly actualQueryCost: number | null;
  readonly throttleStatus: ThrottleStatus;
}

/** Successful GraphQL response. */
export interface AdminResponse<TData> {
  readonly data: TData;
  readonly cost: QueryCost | undefined;
  /** Shopify's `X-Request-ID`, useful in support requests. */
  readonly requestId: string | undefined;
  /** How many HTTP requests were made, including retries (>= 1). */
  readonly attempts: number;
}

export type Sleep = (
  milliseconds: number,
  signal?: AbortSignal
) => Promise<void>;

export interface AdminClientOptions {
  /** `example`, `example.myshopify.com`, or a URL on that host. */
  readonly shop: string;
  /** Admin API access token. Never logged or exposed by the client. */
  readonly accessToken: string;
  /** Explicit API version, `YYYY-MM` (such as `2026-10`) or `unstable`. */
  readonly apiVersion: string;
  /** Custom `fetch`, for tests, proxies or runtimes without a global. */
  readonly fetch?: typeof fetch;
  readonly logger?: Logger;
  /** Retries after the first attempt. Default 3. */
  readonly maxRetries?: number;
  /** First backoff delay in milliseconds. Default 500. */
  readonly retryBaseDelayMs?: number;
  /** Longest wait before a retry; a longer `Retry-After` gives up. Default 10000. */
  readonly maxRetryDelayMs?: number;
  /** Per-attempt timeout in milliseconds. Default 30000. */
  readonly timeoutMs?: number;
  /** Replaces the timer-based wait between retries (for tests). */
  readonly sleep?: Sleep;
  /** Returns a number in [0, 1) for backoff jitter (for tests). */
  readonly random?: () => number;
}

export interface AdminRequestOptions<
  TVariables extends GraphqlVariables = GraphqlVariables,
> {
  readonly variables?: TVariables;
  /** Name sent as `operationName` and used in error messages. */
  readonly operationName?: string;
  readonly signal?: AbortSignal;
  /** Overrides the client's `maxRetries` for this call. */
  readonly maxRetries?: number;
}
