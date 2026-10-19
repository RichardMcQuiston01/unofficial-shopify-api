import type { GraphqlClient } from '../client/graphql-client.js';
import { defaultSleep } from '../client/retry.js';
import type { AdminResponse, Sleep } from '../client/types.js';
import { checkUserErrors } from '../client/user-errors.js';
import {
  BulkOperationError,
  ConfigurationError,
  HttpError,
  NetworkError,
  type UserError,
  type UserErrorDetail,
} from '../errors/errors.js';
import { snippet } from '../internal/text.js';
import { err, ok, type Result } from '../result/result.js';

/** Statuses of Shopify's `BulkOperationStatus` enum. */
export type BulkOperationStatus =
  | 'CREATED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'CANCELING'
  | 'CANCELED'
  | 'FAILED'
  | 'EXPIRED';

/** A bulk operation as returned by the Admin API (large counters converted to numbers). */
export interface BulkOperation {
  readonly id: string;
  readonly status: BulkOperationStatus;
  readonly type: 'QUERY' | 'MUTATION';
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly objectCount: number;
  readonly rootObjectCount: number;
  readonly fileSize: number | null;
  /** JSONL results, valid for 7 days; null when the operation produced nothing. */
  readonly url: string | null;
  /** Partial JSONL results of a failed operation. */
  readonly partialDataUrl: string | null;
}

interface RawBulkOperation {
  readonly id: string;
  readonly status: BulkOperationStatus;
  readonly type: 'QUERY' | 'MUTATION';
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly objectCount: string | number;
  readonly rootObjectCount: string | number;
  readonly fileSize: string | number | null;
  readonly url: string | null;
  readonly partialDataUrl: string | null;
}

const bulkFields: string = `
  id
  status
  type
  errorCode
  createdAt
  completedAt
  objectCount
  rootObjectCount
  fileSize
  url
  partialDataUrl
`;

const runQuery: string = `
  mutation BulkOperationRunQuery($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation {${bulkFields}}
      userErrors { field message code }
    }
  }
`;

const runQueryGrouped: string = `
  mutation BulkOperationRunQuery($query: String!, $groupObjects: Boolean!) {
    bulkOperationRunQuery(query: $query, groupObjects: $groupObjects) {
      bulkOperation {${bulkFields}}
      userErrors { field message code }
    }
  }
`;

const runMutation: string = `
  mutation BulkOperationRunMutation(
    $mutation: String!
    $stagedUploadPath: String!
    $clientIdentifier: String
  ) {
    bulkOperationRunMutation(
      mutation: $mutation
      stagedUploadPath: $stagedUploadPath
      clientIdentifier: $clientIdentifier
    ) {
      bulkOperation {${bulkFields}}
      userErrors { field message code }
    }
  }
`;

// `node(id:)` works on every API version, unlike bulkOperation(id:) (2026-01+)
// and currentBulkOperation (before 2026-01).
const statusQuery: string = `
  query BulkOperationStatus($id: ID!) {
    node(id: $id) {
      ... on BulkOperation {${bulkFields}}
    }
  }
`;

const cancelMutation: string = `
  mutation BulkOperationCancel($id: ID!) {
    bulkOperationCancel(id: $id) {
      bulkOperation {${bulkFields}}
      userErrors { field message }
    }
  }
`;

const stagedUploadMutation: string = `
  mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets { url resourceUrl parameters { name value } }
      userErrors { field message }
    }
  }
`;

function toBulkOperation(raw: RawBulkOperation): BulkOperation {
  return {
    ...raw,
    objectCount: Number(raw.objectCount),
    rootObjectCount: Number(raw.rootObjectCount),
    fileSize: raw.fileSize === null ? null : Number(raw.fileSize),
  };
}

interface RunPayload {
  readonly bulkOperation: RawBulkOperation | null;
  readonly userErrors: readonly UserErrorDetail[];
}

function unwrapRun(
  response: Result<AdminResponse<Record<string, RunPayload>>>,
  key: string,
  operation: string
): Result<BulkOperation> {
  if (!response.ok) return response;
  const payload: RunPayload | undefined = response.value.data[key];
  if (payload === undefined) {
    return err(
      new ConfigurationError(
        `${operation}: the response had no ${key} payload.`
      )
    );
  }
  const checked: Result<RunPayload, UserError> = checkUserErrors(
    payload,
    operation
  );
  if (!checked.ok) return checked;
  if (payload.bulkOperation === null) {
    return err(
      new ConfigurationError(
        `${operation}: Shopify returned no bulk operation and no userErrors.`
      )
    );
  }
  return ok(toBulkOperation(payload.bulkOperation));
}

export interface StartBulkQueryOptions {
  /**
   * Group child objects under their parent in the output. Slower and more
   * likely to time out; leave unset unless you need the grouped format.
   */
  readonly groupObjects?: boolean;
  readonly signal?: AbortSignal;
}

/** Starts a bulk query and returns right away; use `waitForBulkOperation` to follow it. */
export async function startBulkQuery(
  client: GraphqlClient,
  query: string,
  options: StartBulkQueryOptions = {}
): Promise<Result<BulkOperation>> {
  const grouped: boolean = options.groupObjects !== undefined;
  const response: Result<AdminResponse<Record<string, RunPayload>>> =
    await client.request<Record<string, RunPayload>>(
      grouped ? runQueryGrouped : runQuery,
      {
        variables: grouped
          ? { query, groupObjects: options.groupObjects }
          : { query },
        operationName: 'BulkOperationRunQuery',
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }
    );
  return unwrapRun(
    response,
    'bulkOperationRunQuery',
    'Starting the bulk query'
  );
}

export interface StartBulkMutationOptions {
  /** Echoed back by Shopify, for finding the operation later. */
  readonly clientIdentifier?: string;
  readonly signal?: AbortSignal;
}

/**
 * Starts a bulk mutation from a file already uploaded with
 * `stageBulkMutationInput`. The mutation runs once per JSONL line.
 */
export async function startBulkMutation(
  client: GraphqlClient,
  mutation: string,
  stagedUploadPath: string,
  options: StartBulkMutationOptions = {}
): Promise<Result<BulkOperation>> {
  const response: Result<AdminResponse<Record<string, RunPayload>>> =
    await client.request<Record<string, RunPayload>>(runMutation, {
      variables: {
        mutation,
        stagedUploadPath,
        ...(options.clientIdentifier === undefined
          ? {}
          : { clientIdentifier: options.clientIdentifier }),
      },
      operationName: 'BulkOperationRunMutation',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  return unwrapRun(
    response,
    'bulkOperationRunMutation',
    'Starting the bulk mutation'
  );
}

/** Reads the current state of a bulk operation. */
export async function getBulkOperation(
  client: GraphqlClient,
  id: string,
  options: { readonly signal?: AbortSignal } = {}
): Promise<Result<BulkOperation>> {
  const response: Result<
    AdminResponse<{ node: Partial<RawBulkOperation> | null }>
  > = await client.request<{ node: Partial<RawBulkOperation> | null }>(
    statusQuery,
    {
      variables: { id },
      operationName: 'BulkOperationStatus',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }
  );
  if (!response.ok) return response;
  const node: Partial<RawBulkOperation> | null = response.value.data.node;
  if (node === null || node.status === undefined) {
    return err(
      new BulkOperationError(
        `Bulk operation ${id} was not found on ${client.shop}; check the ID, and that it belongs to this shop and app.`,
        {
          bulkOperationId: id,
          status: 'NOT_FOUND',
          errorCode: null,
          partialDataUrl: null,
        }
      )
    );
  }
  return ok(toBulkOperation(node as RawBulkOperation));
}

/** Asks Shopify to cancel a running operation. It may take a moment to reach CANCELED. */
export async function cancelBulkOperation(
  client: GraphqlClient,
  id: string
): Promise<Result<BulkOperation>> {
  const response: Result<AdminResponse<Record<string, RunPayload>>> =
    await client.request<Record<string, RunPayload>>(cancelMutation, {
      variables: { id },
      operationName: 'BulkOperationCancel',
    });
  return unwrapRun(
    response,
    'bulkOperationCancel',
    'Canceling the bulk operation'
  );
}

export interface WaitForBulkOperationOptions {
  /** First wait between polls. Default 2000. */
  readonly pollIntervalMs?: number;
  /** Polls slow down by half each time, up to this. Default 10000. */
  readonly maxPollIntervalMs?: number;
  /** Give up waiting (the operation keeps running). Default one hour. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Called with every status read, for progress output. */
  readonly onProgress?: (operation: BulkOperation) => void;
  /** Replaces the timer-based wait (for tests). */
  readonly sleep?: Sleep;
  /** Clock in epoch milliseconds (for tests). */
  readonly now?: () => number;
}

/**
 * Polls until the operation completes. A failed, canceled or expired
 * operation, or running out of `timeoutMs`, returns a `BulkOperationError`
 * carrying the status, error code and partial-results URL. A webhook on the
 * `bulk_operations/finish` topic avoids polling altogether.
 */
export async function waitForBulkOperation(
  client: GraphqlClient,
  id: string,
  options: WaitForBulkOperationOptions = {}
): Promise<Result<BulkOperation>> {
  const sleep: Sleep = options.sleep ?? defaultSleep;
  const now: () => number = options.now ?? Date.now;
  const maxInterval: number = options.maxPollIntervalMs ?? 10_000;
  const timeoutMs: number = options.timeoutMs ?? 3_600_000;
  const deadline: number = now() + timeoutMs;
  let interval: number = options.pollIntervalMs ?? 2000;

  for (;;) {
    const current: Result<BulkOperation> = await getBulkOperation(
      client,
      id,
      options.signal === undefined ? {} : { signal: options.signal }
    );
    if (!current.ok) return current;
    const operation: BulkOperation = current.value;
    options.onProgress?.(operation);

    if (operation.status === 'COMPLETED') return current;
    if (
      operation.status === 'FAILED' ||
      operation.status === 'CANCELED' ||
      operation.status === 'EXPIRED'
    ) {
      return err(
        new BulkOperationError(
          `Bulk operation ${id} on ${client.shop} ended as ${operation.status}` +
            (operation.errorCode === null ? '' : ` (${operation.errorCode})`) +
            (operation.partialDataUrl === null
              ? '.'
              : '; partial results are available at partialDataUrl.'),
          {
            bulkOperationId: id,
            status: operation.status,
            errorCode: operation.errorCode,
            partialDataUrl: operation.partialDataUrl,
            context: { operation: 'waitForBulkOperation', shop: client.shop },
          }
        )
      );
    }
    if (now() + interval > deadline) {
      return err(
        new BulkOperationError(
          `Stopped waiting for bulk operation ${id} on ${client.shop} after ${String(timeoutMs)} ms; it is still ${operation.status} (${String(operation.objectCount)} objects so far) and keeps running. ` +
            'Wait again, or cancel it with cancelBulkOperation.',
          {
            bulkOperationId: id,
            status: operation.status,
            errorCode: null,
            partialDataUrl: null,
            context: { operation: 'waitForBulkOperation', shop: client.shop },
          }
        )
      );
    }
    try {
      await sleep(interval, options.signal);
    } catch (thrown: unknown) {
      return err(
        new NetworkError(
          `Waiting for bulk operation ${id} on ${client.shop} was aborted.`,
          {
            cause: thrown,
            context: { operation: 'waitForBulkOperation', shop: client.shop },
          }
        )
      );
    }
    interval = Math.min(maxInterval, Math.round(interval * 1.5));
  }
}

/** Starts a bulk query and waits for it to complete. */
export async function runBulkQuery(
  client: GraphqlClient,
  query: string,
  options: StartBulkQueryOptions & WaitForBulkOperationOptions = {}
): Promise<Result<BulkOperation>> {
  const started: Result<BulkOperation> = await startBulkQuery(
    client,
    query,
    options
  );
  if (!started.ok) return started;
  return waitForBulkOperation(client, started.value.id, options);
}

/** One JSON object per line of mutation variables, or a ready-made JSONL string. */
export type BulkMutationInput =
  string | readonly Readonly<Record<string, unknown>>[];

interface StagedTarget {
  readonly url: string | null;
  readonly parameters: readonly {
    readonly name: string;
    readonly value: string;
  }[];
}

interface StagedUploadData {
  readonly stagedUploadsCreate: {
    readonly stagedTargets: readonly StagedTarget[] | null;
    readonly userErrors: readonly UserErrorDetail[];
  };
}

/**
 * Uploads mutation variables for a bulk mutation: reserves a staged upload,
 * then POSTs the JSONL file to the returned URL (without your access token,
 * which belongs to Shopify's API only). Resolves the `stagedUploadPath` to pass
 * to `startBulkMutation`.
 */
export async function stageBulkMutationInput(
  client: GraphqlClient,
  input: BulkMutationInput,
  options: { readonly fetch?: typeof fetch; readonly signal?: AbortSignal } = {}
): Promise<Result<string>> {
  const jsonl: string =
    typeof input === 'string'
      ? input
      : input
          .map((line: Readonly<Record<string, unknown>>): string =>
            JSON.stringify(line)
          )
          .join('\n');
  if (jsonl.trim() === '') {
    return err(
      new ConfigurationError(
        'The bulk mutation input is empty; supply at least one line of variables.'
      )
    );
  }
  const reserved: Result<AdminResponse<StagedUploadData>> =
    await client.request<StagedUploadData>(stagedUploadMutation, {
      variables: {
        input: [
          {
            resource: 'BULK_MUTATION_VARIABLES',
            filename: 'bulk_op_vars',
            mimeType: 'text/jsonl',
            httpMethod: 'POST',
          },
        ],
      },
      operationName: 'StagedUploadsCreate',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  if (!reserved.ok) return reserved;
  const payload: StagedUploadData['stagedUploadsCreate'] =
    reserved.value.data.stagedUploadsCreate;
  const checked: Result<unknown, UserError> = checkUserErrors(
    payload,
    'Reserving the staged upload'
  );
  if (!checked.ok) return checked;
  const target: StagedTarget | undefined = payload.stagedTargets?.[0];
  if (
    target?.url === undefined ||
    target.url === null ||
    !target.url.startsWith('https://')
  ) {
    return err(
      new ConfigurationError(
        'Shopify returned no https upload URL for the staged upload.'
      )
    );
  }
  const key: string | undefined = target.parameters.find(
    (parameter: { readonly name: string }): boolean => parameter.name === 'key'
  )?.value;
  if (key === undefined) {
    return err(
      new ConfigurationError(
        'The staged upload had no "key" parameter, so the upload path is unknown.'
      )
    );
  }

  // Shopify's signed fields first, the file last, as the storage service requires.
  const form: FormData = new FormData();
  for (const parameter of target.parameters)
    form.append(parameter.name, parameter.value);
  form.append(
    'file',
    new Blob([jsonl], { type: 'text/jsonl' }),
    'bulk_op_vars'
  );
  const uploadFetch: typeof fetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await uploadFetch(target.url, {
      method: 'POST',
      body: form,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (thrown: unknown) {
    return err(
      new NetworkError(
        `Uploading the bulk mutation input failed: ${thrown instanceof Error ? thrown.message : String(thrown)}.`,
        {
          cause: thrown,
          context: { operation: 'stageBulkMutationInput', shop: client.shop },
        }
      )
    );
  }
  if (!response.ok) {
    const body: string = await response.text().catch((): string => '');
    return err(
      new HttpError(
        `Uploading the bulk mutation input was rejected (HTTP ${String(response.status)})${body === '' ? '' : `: "${snippet(body)}"`}.`,
        {
          context: {
            operation: 'stageBulkMutationInput',
            shop: client.shop,
            status: response.status,
          },
        }
      )
    );
  }
  return ok(key);
}

export interface RunBulkMutationOptions
  extends StartBulkMutationOptions, WaitForBulkOperationOptions {
  /** Used for the file upload only. */
  readonly fetch?: typeof fetch;
}

/** Uploads the variables, starts the bulk mutation and waits for it to complete. */
export async function runBulkMutation(
  client: GraphqlClient,
  mutation: string,
  input: BulkMutationInput,
  options: RunBulkMutationOptions = {}
): Promise<Result<BulkOperation>> {
  const staged: Result<string> = await stageBulkMutationInput(
    client,
    input,
    options
  );
  if (!staged.ok) return staged;
  const started: Result<BulkOperation> = await startBulkMutation(
    client,
    mutation,
    staged.value,
    options
  );
  if (!started.ok) return started;
  return waitForBulkOperation(client, started.value.id, options);
}
