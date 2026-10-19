import { HttpError, NetworkError } from '../errors/errors.js';
import { err, ok, type Result } from '../result/result.js';

/* eslint-disable @typescript-eslint/naming-convention -- `__parentId` is Shopify's field name. */
/**
 * One line of a bulk operation result. Child rows of a connection carry the
 * `__parentId` of the row they belong to.
 */
export interface BulkRow {
  readonly id?: string;
  readonly __parentId?: string;
  readonly [field: string]: unknown;
}
/* eslint-enable @typescript-eslint/naming-convention */

export interface StreamBulkResultsOptions {
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}

/** Drops the query string, which holds the URL's signature, before it reaches a message. */
function withoutQuery(url: string): string {
  const index: number = url.indexOf('?');
  return index === -1 ? url : url.slice(0, index);
}

/**
 * Streams the rows of a bulk operation's JSONL result one at a time, without
 * loading the file into memory. Pass `operation.url`; null (no results) yields
 * nothing. The file is fetched without your access token. After an `Err` is
 * yielded the iteration ends.
 */
export async function* streamBulkResults<TRow = BulkRow>(
  url: string | null,
  options: StreamBulkResultsOptions = {}
): AsyncGenerator<Result<TRow>, void, undefined> {
  if (url === null) return;
  if (!url.startsWith('https://')) {
    yield err(
      new HttpError(`Bulk result URL "${withoutQuery(url)}" must use https.`)
    );
    return;
  }
  const download: typeof fetch = options.fetch ?? fetch;
  const shown: string = withoutQuery(url);

  let response: Response;
  try {
    response = await download(
      url,
      options.signal === undefined ? {} : { signal: options.signal }
    );
  } catch (thrown: unknown) {
    yield err(
      new NetworkError(
        `Downloading bulk results from ${shown} failed: ${thrown instanceof Error ? thrown.message : String(thrown)}.`,
        { cause: thrown }
      )
    );
    return;
  }
  if (!response.ok) {
    yield err(
      new HttpError(
        `Downloading bulk results from ${shown} returned HTTP ${String(response.status)}; the link may have expired (results last 7 days).`,
        { context: { status: response.status } }
      )
    );
    return;
  }

  const decoder: TextDecoder = new TextDecoder('utf-8');
  let lineNumber: number = 0;
  let pending: string = '';

  function parse(line: string): Result<TRow> | undefined {
    if (line.trim() === '') return undefined;
    lineNumber += 1;
    try {
      return ok(JSON.parse(line) as TRow);
    } catch (thrown: unknown) {
      return err(
        new HttpError(
          `Bulk results line ${String(lineNumber)} is not valid JSON: "${line.slice(0, 80)}".`,
          {
            cause: thrown,
          }
        )
      );
    }
  }

  try {
    if (response.body === null) {
      pending = await response.text();
    } else {
      const reader: ReadableStreamDefaultReader<Uint8Array> =
        response.body.getReader();
      for (;;) {
        const chunk: ReadableStreamReadResult<Uint8Array> = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        let newline: number = pending.indexOf('\n');
        while (newline !== -1) {
          const parsed: Result<TRow> | undefined = parse(
            pending.slice(0, newline)
          );
          pending = pending.slice(newline + 1);
          if (parsed !== undefined) {
            yield parsed;
            if (!parsed.ok) {
              await reader.cancel();
              return;
            }
          }
          newline = pending.indexOf('\n');
        }
      }
      pending += decoder.decode();
    }
  } catch (thrown: unknown) {
    yield err(
      new NetworkError(
        `Reading bulk results from ${shown} failed: ${thrown instanceof Error ? thrown.message : String(thrown)}.`,
        { cause: thrown }
      )
    );
    return;
  }
  for (const line of pending.split('\n')) {
    const parsed: Result<TRow> | undefined = parse(line);
    if (parsed === undefined) continue;
    yield parsed;
    if (!parsed.ok) return;
  }
}

/** Reads a whole result file into an array. Prefer `streamBulkResults` for large files. */
export async function collectBulkResults<TRow = BulkRow>(
  url: string | null,
  options: StreamBulkResultsOptions & { readonly maxRows?: number } = {}
): Promise<Result<TRow[]>> {
  const rows: TRow[] = [];
  for await (const row of streamBulkResults<TRow>(url, options)) {
    if (!row.ok) return row;
    rows.push(row.value);
    if (options.maxRows !== undefined && rows.length > options.maxRows) {
      return err(
        new HttpError(
          `Bulk results have more than maxRows (${String(options.maxRows)}) rows; stream them with streamBulkResults instead.`
        )
      );
    }
  }
  return ok(rows);
}
