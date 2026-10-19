import {
  AuthenticationError,
  ConfigurationError,
  GraphqlError,
  HttpError,
  NetworkError,
  ShopifyError,
  ThrottledError,
  type GraphqlErrorDetail,
  type ShopifyErrorContext,
} from '../errors/errors.js';
import { noopLogger, type Logger } from '../logger/logger.js';
import { err, ok, type Result } from '../result/result.js';
import { backoffDelayMs, defaultSleep, parseRetryAfterMs } from './retry.js';
import { normalizeShopDomain, validateApiVersion } from './shop.js';
import type {
  AdminClientOptions,
  AdminRequestOptions,
  AdminResponse,
  GraphqlDocument,
  GraphqlVariables,
  QueryCost,
  Sleep,
} from './types.js';

/** Client for one shop's Admin GraphQL API. Holds the token privately. */
export interface AdminClient {
  /** Normalized `example.myshopify.com`. */
  readonly shop: string;
  readonly apiVersion: string;
  request<
    TData = unknown,
    TVariables extends GraphqlVariables = GraphqlVariables,
  >(
    document: GraphqlDocument<TData, TVariables>,
    options?: AdminRequestOptions<TVariables>
  ): Promise<Result<AdminResponse<TData>>>;
}

interface ResponseBody {
  readonly data?: unknown;
  readonly errors?: unknown;
  readonly extensions?: { readonly cost?: QueryCost };
}

const defaultMaxRetries: number = 3;
const defaultRetryBaseDelayMs: number = 500;
const defaultMaxRetryDelayMs: number = 10_000;
const defaultTimeoutMs: number = 30_000;
const bodySnippetLength: number = 200;

/**
 * Creates an Admin GraphQL client. Returns an `Err` for invalid configuration
 * instead of throwing.
 */
export function createAdminClient(
  options: AdminClientOptions
): Result<AdminClient, ConfigurationError> {
  const shopResult: Result<string, ConfigurationError> = normalizeShopDomain(
    options.shop
  );
  if (!shopResult.ok) return shopResult;
  const versionResult: Result<string, ConfigurationError> = validateApiVersion(
    options.apiVersion
  );
  if (!versionResult.ok) return versionResult;
  if (options.accessToken.trim() === '') {
    return err(
      new ConfigurationError(
        `accessToken for shop ${shopResult.value} is empty; pass the Admin API access token.`
      )
    );
  }
  const maybeFetch: typeof fetch | undefined =
    options.fetch ?? (typeof fetch === 'function' ? fetch : undefined);
  if (maybeFetch === undefined) {
    return err(
      new ConfigurationError(
        'No global fetch is available in this runtime; pass one as the `fetch` option.'
      )
    );
  }
  const numericChecks: readonly [string, number | undefined][] = [
    ['maxRetries', options.maxRetries],
    ['retryBaseDelayMs', options.retryBaseDelayMs],
    ['maxRetryDelayMs', options.maxRetryDelayMs],
    ['timeoutMs', options.timeoutMs],
  ];
  for (const [name, value] of numericChecks) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      return err(
        new ConfigurationError(
          `${name} must be a non-negative number, received ${String(value)}.`
        )
      );
    }
  }

  const fetchImplementation: typeof fetch = maybeFetch;
  const shop: string = shopResult.value;
  const apiVersion: string = versionResult.value;
  const endpoint: string = `https://${shop}/admin/api/${apiVersion}/graphql.json`;
  const accessToken: string = options.accessToken;
  const logger: Logger = options.logger ?? noopLogger;
  const sleep: Sleep = options.sleep ?? defaultSleep;
  const random: () => number = options.random ?? Math.random;
  const retryBaseDelayMs: number =
    options.retryBaseDelayMs ?? defaultRetryBaseDelayMs;
  const maxRetryDelayMs: number =
    options.maxRetryDelayMs ?? defaultMaxRetryDelayMs;
  const timeoutMs: number = options.timeoutMs ?? defaultTimeoutMs;

  async function request<TData, TVariables extends GraphqlVariables>(
    document: GraphqlDocument<TData, TVariables>,
    requestOptions: AdminRequestOptions<TVariables> = {}
  ): Promise<Result<AdminResponse<TData>>> {
    const query: string = String(document);
    const operation: string = requestOptions.operationName ?? 'GraphQL request';
    const retrySafe: boolean = !/\bmutation\b/.test(stripNoise(query));
    const maxRetries: number =
      requestOptions.maxRetries ?? options.maxRetries ?? defaultMaxRetries;
    const body: string = JSON.stringify({
      query,
      variables: requestOptions.variables,
      operationName: requestOptions.operationName,
    });

    for (let attempt: number = 1; ; attempt++) {
      const outcome: Result<AdminResponse<TData>> = await attemptOnce<TData>(
        body,
        operation,
        attempt,
        requestOptions.signal
      );
      if (outcome.ok) return outcome;

      const delayMs: number | undefined = retryDelayMs(
        outcome.error,
        attempt,
        maxRetries,
        retrySafe
      );
      if (delayMs === undefined || requestOptions.signal?.aborted === true) {
        return outcome;
      }
      logger.warn(`${operation} failed; retrying`, {
        shop,
        attempt,
        delayMs,
        code: outcome.error.code,
        status: outcome.error.context.status,
      });
      try {
        await sleep(delayMs, requestOptions.signal);
      } catch (thrown: unknown) {
        return err(
          new NetworkError(
            `${operation} on ${shop} was aborted while waiting to retry.`,
            { cause: thrown, context: { operation, shop } }
          )
        );
      }
    }
  }

  /** Returns the wait before the next attempt, or undefined to give up. */
  function retryDelayMs(
    error: ShopifyError,
    attempt: number,
    maxRetries: number,
    retrySafe: boolean
  ): number | undefined {
    if (attempt > maxRetries) return undefined;
    if (error instanceof ThrottledError) {
      // Shopify did not run a throttled operation, so retrying is safe.
      if (error.retryAfterMs === undefined) {
        return backoffDelayMs(
          attempt,
          retryBaseDelayMs,
          maxRetryDelayMs,
          random
        );
      }
      return error.retryAfterMs > maxRetryDelayMs
        ? undefined
        : error.retryAfterMs;
    }
    const transient: boolean =
      error instanceof NetworkError ||
      (error instanceof HttpError && (error.context.status ?? 0) >= 500);
    if (!transient || !retrySafe) return undefined;
    return backoffDelayMs(attempt, retryBaseDelayMs, maxRetryDelayMs, random);
  }

  async function attemptOnce<TData>(
    body: string,
    operation: string,
    attempt: number,
    callerSignal: AbortSignal | undefined
  ): Promise<Result<AdminResponse<TData>>> {
    const context: ShopifyErrorContext = { operation, shop };
    const timeoutSignal: AbortSignal = AbortSignal.timeout(timeoutMs);
    const signal: AbortSignal =
      callerSignal === undefined
        ? timeoutSignal
        : AbortSignal.any([callerSignal, timeoutSignal]);

    logger.debug(`${operation} attempt ${String(attempt)}`, { shop, endpoint });
    let response: Response;
    try {
      response = await fetchImplementation(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Shopify-Access-Token': accessToken,
        },
        body,
        signal,
      });
    } catch (thrown: unknown) {
      return err(
        describeFetchFailure(thrown, operation, callerSignal, context)
      );
    }

    const requestId: string | undefined =
      response.headers.get('x-request-id') ?? undefined;
    const withStatus: ShopifyErrorContext = {
      ...context,
      status: response.status,
      ...(requestId === undefined ? {} : { requestId }),
    };
    let text: string;
    try {
      text = await response.text();
    } catch (thrown: unknown) {
      return err(
        new NetworkError(
          `${operation} on ${shop}: the connection failed while reading the response body (HTTP ${String(response.status)}).`,
          { cause: thrown, context: withStatus }
        )
      );
    }

    if (!response.ok) {
      return err(httpFailure(response, text, operation, withStatus));
    }

    let parsed: ResponseBody;
    try {
      parsed = JSON.parse(text) as ResponseBody;
    } catch (thrown: unknown) {
      return err(
        new HttpError(
          `${operation} on ${shop}: Shopify returned HTTP 200 with a body that is not valid JSON: "${snippet(text)}".`,
          { cause: thrown, context: withStatus }
        )
      );
    }

    const cost: QueryCost | undefined = parsed.extensions?.cost;
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      return err(
        graphqlFailure(
          parsed.errors as GraphqlErrorDetail[],
          cost,
          operation,
          shop,
          withStatus
        )
      );
    }
    if (parsed.data === undefined || parsed.data === null) {
      return err(
        new HttpError(
          `${operation} on ${shop}: the response had neither "data" nor "errors".`,
          { context: withStatus }
        )
      );
    }
    return ok({
      data: parsed.data as TData,
      cost,
      requestId,
      attempts: attempt,
    });
  }

  return ok({ shop, apiVersion, request });
}

function describeFetchFailure(
  thrown: unknown,
  operation: string,
  callerSignal: AbortSignal | undefined,
  context: ShopifyErrorContext
): NetworkError {
  const shop: string = context.shop ?? 'the shop';
  const name: string = thrown instanceof Error ? thrown.name : '';
  const reason: string =
    thrown instanceof Error ? thrown.message : String(thrown);
  if (callerSignal?.aborted === true) {
    return new NetworkError(
      `${operation} on ${shop} was aborted by the caller.`,
      {
        cause: thrown,
        context,
      }
    );
  }
  if (name === 'TimeoutError') {
    return new NetworkError(
      `${operation} on ${shop} timed out before Shopify responded.`,
      { cause: thrown, context }
    );
  }
  return new NetworkError(
    `${operation} on ${shop} failed before a response was received: ${reason}.`,
    { cause: thrown, context }
  );
}

function httpFailure(
  response: Response,
  text: string,
  operation: string,
  context: ShopifyErrorContext
): ShopifyError {
  const shop: string = context.shop ?? 'the shop';
  const status: number = response.status;
  const detail: string = text === '' ? '' : `: "${snippet(text)}"`;
  if (status === 401 || status === 403) {
    return new AuthenticationError(
      `${operation} on ${shop}: Shopify rejected the access token or the app lacks permission (HTTP ${String(status)})${detail}.`,
      { context }
    );
  }
  if (status === 429) {
    const retryAfterMs: number | undefined = parseRetryAfterMs(
      response.headers.get('retry-after')
    );
    return new ThrottledError(
      `${operation} on ${shop}: Shopify rate limit exceeded (HTTP 429).`,
      { context, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }
    );
  }
  const hint: string =
    status === 404
      ? ' The shop or API version was not found; check the shop domain and apiVersion.'
      : status === 402
        ? ' The shop is frozen or unpaid.'
        : '';
  return new HttpError(
    `${operation} on ${shop}: Shopify returned HTTP ${String(status)}${detail}.${hint}`,
    { context }
  );
}

function graphqlFailure(
  errors: readonly GraphqlErrorDetail[],
  cost: QueryCost | undefined,
  operation: string,
  shop: string,
  context: ShopifyErrorContext
): ShopifyError {
  const codeOf = (detail: GraphqlErrorDetail): unknown =>
    detail.extensions?.['code'];
  const summary: string = errors
    .map((detail: GraphqlErrorDetail): string => detail.message)
    .join('; ');
  if (
    errors.some((detail: GraphqlErrorDetail) => codeOf(detail) === 'THROTTLED')
  ) {
    const retryAfterMs: number | undefined = waitForBudgetMs(cost);
    return new ThrottledError(
      `${operation} on ${shop}: GraphQL cost limit exceeded (${summary}).`,
      { context, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }
    );
  }
  if (
    errors.some(
      (detail: GraphqlErrorDetail) => codeOf(detail) === 'ACCESS_DENIED'
    )
  ) {
    return new AuthenticationError(
      `${operation} on ${shop}: access denied, the app is probably missing an access scope (${summary}).`,
      { context }
    );
  }
  return new GraphqlError(`${operation} on ${shop} failed: ${summary}.`, {
    errors,
    context,
  });
}

/** Milliseconds until the bucket holds enough points for the throttled query. */
function waitForBudgetMs(cost: QueryCost | undefined): number | undefined {
  if (cost === undefined || cost.throttleStatus.restoreRate <= 0)
    return undefined;
  const missing: number =
    cost.requestedQueryCost - cost.throttleStatus.currentlyAvailable;
  if (missing <= 0) return 0;
  return Math.ceil((missing / cost.throttleStatus.restoreRate) * 1000);
}

/** Removes comments and string literals so keyword checks see only syntax. */
function stripNoise(query: string): string {
  return query
    .replace(/"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/#[^\n]*/g, '');
}

function snippet(text: string): string {
  const collapsed: string = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > bodySnippetLength
    ? `${collapsed.slice(0, bodySnippetLength)}…`
    : collapsed;
}
