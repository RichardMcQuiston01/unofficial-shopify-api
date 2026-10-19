import {
  collectNodes,
  runBulkQuery,
  streamBulkResults,
  type AdminClient,
  type BulkOperation,
  type PageInfo,
  type Result,
} from '@richardmcquiston01/unofficial-shopify-api';

interface ProductsData {
  readonly products: {
    readonly nodes: readonly { readonly id: string; readonly title: string }[];
    readonly pageInfo: PageInfo;
  };
}

const productsQuery: string = `
  query Products($after: String) {
    products(first: 100, after: $after) {
      nodes { id title }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/** A few hundred products: page through them with a normal query. */
export function listProducts(
  client: AdminClient
): Promise<Result<{ id: string; title: string }[]>> {
  return collectNodes<ProductsData, { id: string; title: string }>(
    client,
    productsQuery,
    {
      select: (data: ProductsData) => data.products,
      operationName: 'Products',
      maxItems: 10_000,
    }
  );
}

/** The whole catalog: a bulk operation, streamed so it never sits in memory. */
export async function exportProductTitles(
  client: AdminClient,
  onTitle: (title: string) => void,
  /** Only needed to replace the global `fetch`, such as in tests. */
  options: { readonly fetch?: typeof fetch } = {}
): Promise<Result<number>> {
  const done: Result<BulkOperation> = await runBulkQuery(
    client,
    '{ products { edges { node { id title } } } }'
  );
  if (!done.ok) return done;

  let count: number = 0;
  for await (const row of streamBulkResults(done.value.url, options)) {
    if (!row.ok) return row;
    if (typeof row.value['title'] === 'string') onTitle(row.value['title']);
    count += 1;
  }
  return { ok: true, value: count };
}
