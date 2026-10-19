import type { GraphqlClient } from '../client/graphql-client.js';
import type {
  AdminResponse,
  GraphqlDocument,
  GraphqlVariables,
} from '../client/types.js';
import { PaginationError } from '../errors/errors.js';
import { err, ok, type Result } from '../result/result.js';

/** The pagination part of every GraphQL connection. */
export interface PageInfo {
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

/** A connection selected by `nodes` or by `edges { node }`. */
export interface ConnectionLike<TNode> {
  readonly nodes?: readonly TNode[] | null;
  readonly edges?: readonly { readonly node: TNode }[] | null;
  readonly pageInfo: PageInfo;
}

export interface PaginateOptions<TData, TNode> {
  /** Picks the connection out of the response data. */
  readonly select: (data: TData) => ConnectionLike<TNode> | null | undefined;
  /** Variables for the query, except the cursor. */
  readonly variables?: GraphqlVariables;
  /** Name of the cursor variable in the query. Default `after`. */
  readonly cursorVariable?: string;
  readonly operationName?: string;
  readonly signal?: AbortSignal;
  /** Stop with an error after this many pages. Default 1000. */
  readonly maxPages?: number;
}

const defaultMaxPages: number = 1000;

function nodesOf<TNode>(connection: ConnectionLike<TNode>): readonly TNode[] {
  if (connection.nodes !== undefined && connection.nodes !== null) {
    return connection.nodes;
  }
  return (connection.edges ?? []).map(
    (edge: { readonly node: TNode }): TNode => edge.node
  );
}

/**
 * Walks a cursor-paginated connection, yielding the nodes of one page at a
 * time. The query must declare the cursor variable (`$after: String`) and pass
 * it to the connection. After an `Err` is yielded the iteration ends.
 *
 * @example
 * for await (const page of paginate(client, query, { select: (d) => d.products })) {
 *   if (!page.ok) return page;
 *   for (const product of page.value) ...
 * }
 */
export async function* paginate<TData, TNode>(
  client: GraphqlClient,
  document: GraphqlDocument<TData>,
  options: PaginateOptions<TData, TNode>
): AsyncGenerator<Result<readonly TNode[]>, void, undefined> {
  const cursorVariable: string = options.cursorVariable ?? 'after';
  const maxPages: number = options.maxPages ?? defaultMaxPages;
  const operation: string = options.operationName ?? 'Paginated query';
  let cursor: string | null = null;

  for (let page: number = 1; ; page++) {
    if (page > maxPages) {
      yield err(
        new PaginationError(
          `${operation} stopped after ${String(maxPages)} pages while more remained; raise maxPages or narrow the query.`,
          { context: { operation, shop: client.shop } }
        )
      );
      return;
    }
    const response: Result<AdminResponse<TData>> = await client.request<TData>(
      document,
      {
        variables: { ...options.variables, [cursorVariable]: cursor },
        operationName: options.operationName ?? 'PaginatedQuery',
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }
    );
    if (!response.ok) {
      yield response;
      return;
    }
    const connection: ConnectionLike<TNode> | null | undefined = options.select(
      response.value.data
    );
    if (connection === null || connection === undefined) {
      yield err(
        new PaginationError(
          `${operation} page ${String(page)}: select() found no connection in the response (is the field null or the path wrong?).`,
          { context: { operation, shop: client.shop } }
        )
      );
      return;
    }
    yield ok(nodesOf(connection));
    if (!connection.pageInfo.hasNextPage) return;
    const next: string | null = connection.pageInfo.endCursor;
    if (next === null || next === cursor) {
      yield err(
        new PaginationError(
          `${operation} page ${String(page)}: hasNextPage is true but endCursor is ${next === null ? 'null' : 'unchanged'}, so paging cannot continue.`,
          { context: { operation, shop: client.shop } }
        )
      );
      return;
    }
    cursor = next;
  }
}

export interface CollectOptions<TData, TNode> extends PaginateOptions<
  TData,
  TNode
> {
  /** Stop with an error once this many nodes were collected. Default unlimited. */
  readonly maxItems?: number;
}

/** Collects every node of a connection into one array. */
export async function collectNodes<TData, TNode>(
  client: GraphqlClient,
  document: GraphqlDocument<TData>,
  options: CollectOptions<TData, TNode>
): Promise<Result<TNode[]>> {
  const nodes: TNode[] = [];
  for await (const page of paginate(client, document, options)) {
    if (!page.ok) return page;
    nodes.push(...page.value);
    if (options.maxItems !== undefined && nodes.length > options.maxItems) {
      return err(
        new PaginationError(
          `${options.operationName ?? 'Paginated query'} returned more than maxItems (${String(options.maxItems)}); use paginate() to stream, or raise maxItems.`,
          { context: { shop: client.shop } }
        )
      );
    }
  }
  return ok(nodes);
}
