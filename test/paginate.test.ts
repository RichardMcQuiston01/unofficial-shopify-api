import { describe, expect, it } from 'vitest';

import {
  NetworkError,
  PaginationError,
  collectNodes,
  paginate,
  type PageInfo,
  type Result,
} from '../src/index.js';
import { scriptedClient, type ScriptedClient } from './helpers.js';

interface Product {
  readonly id: number;
}
interface Data {
  readonly products: {
    readonly nodes?: readonly Product[];
    readonly edges?: readonly { readonly node: Product }[];
    readonly pageInfo: PageInfo;
  } | null;
}

/** Serves `total` products, `size` per page, with numeric string cursors. */
function productPages(
  total: number,
  size: number,
  shape: 'nodes' | 'edges' = 'nodes'
) {
  return (variables: Record<string, unknown>): Data => {
    const start: number =
      variables['after'] === null ? 0 : Number(variables['after']);
    const items: Product[] = Array.from(
      { length: Math.max(0, Math.min(size, total - start)) },
      (unused: unknown, index: number): Product => ({ id: start + index + 1 })
    );
    const pageInfo: PageInfo = {
      hasNextPage: start + size < total,
      endCursor: String(start + size),
    };
    return {
      products:
        shape === 'nodes'
          ? { nodes: items, pageInfo }
          : { edges: items.map((node: Product) => ({ node })), pageInfo },
    };
  };
}

const select = (data: Data): Data['products'] => data.products;

async function pagesOf(
  scripted: ScriptedClient,
  options: Partial<Parameters<typeof paginate<Data, Product>>[2]> = {}
): Promise<Result<readonly Product[]>[]> {
  const pages: Result<readonly Product[]>[] = [];
  for await (const page of paginate<Data, Product>(
    scripted.client,
    '{ products }',
    {
      select,
      operationName: 'Products',
      ...options,
    }
  )) {
    pages.push(page);
  }
  return pages;
}

describe('paginate', () => {
  it('yields one result per page and passes the cursor along', async () => {
    const scripted: ScriptedClient = scriptedClient({
      Products: productPages(5, 2),
    });
    const pages: Result<readonly Product[]>[] = await pagesOf(scripted);
    expect(
      pages.map((page) =>
        page.ok ? page.value.map((item: Product) => item.id) : null
      )
    ).toEqual([[1, 2], [3, 4], [5]]);
    expect(scripted.calls.map((call) => call.variables['after'])).toEqual([
      null,
      '2',
      '4',
    ]);
  });

  it('reads edges as well as nodes', async () => {
    const scripted: ScriptedClient = scriptedClient({
      Products: productPages(3, 2, 'edges'),
    });
    const pages: Result<readonly Product[]>[] = await pagesOf(scripted);
    expect(
      pages.flatMap((page) =>
        page.ok ? page.value.map((item: Product) => item.id) : []
      )
    ).toEqual([1, 2, 3]);
  });

  it('merges caller variables and supports another cursor variable', async () => {
    const scripted: ScriptedClient = scriptedClient({
      Products: (variables: Record<string, unknown>): Data =>
        productPages(3, 2)({ after: variables['cursor'] }),
    });
    await pagesOf(scripted, {
      variables: { first: 2 },
      cursorVariable: 'cursor',
    });
    expect(scripted.calls[0]?.variables).toEqual({ first: 2, cursor: null });
    expect(scripted.calls[1]?.variables).toEqual({ first: 2, cursor: '2' });
  });

  it('handles an empty connection', async () => {
    const scripted: ScriptedClient = scriptedClient({
      Products: productPages(0, 2),
    });
    const pages: Result<readonly Product[]>[] = await pagesOf(scripted);
    expect(pages).toEqual([{ ok: true, value: [] }]);
  });

  it('yields the client error and stops', async () => {
    let calls: number = 0;
    const scripted: ScriptedClient = scriptedClient({
      Products: (variables: Record<string, unknown>): unknown =>
        ++calls === 2
          ? new NetworkError('offline')
          : productPages(6, 2)(variables),
    });
    const pages: Result<readonly Product[]>[] = await pagesOf(scripted);
    expect(pages).toHaveLength(2);
    expect(pages[1]?.ok).toBe(false);
  });

  it('stops with a PaginationError when the connection is missing', async () => {
    const scripted: ScriptedClient = scriptedClient({
      Products: (): Data => ({ products: null }),
    });
    const pages: Result<readonly Product[]>[] = await pagesOf(scripted);
    expect(!pages[0]?.ok && pages[0]?.error).toBeInstanceOf(PaginationError);
    expect(!pages[0]?.ok && pages[0]?.error.message).toContain('no connection');
  });

  it('refuses to loop on a missing or repeated cursor', async () => {
    const nullCursor: ScriptedClient = scriptedClient({
      Products: (): Data => ({
        products: {
          nodes: [],
          pageInfo: { hasNextPage: true, endCursor: null },
        },
      }),
    });
    expect((await pagesOf(nullCursor)).at(-1)).toMatchObject({ ok: false });
    const sameCursor: ScriptedClient = scriptedClient({
      Products: (): Data => ({
        products: {
          nodes: [],
          pageInfo: { hasNextPage: true, endCursor: 'x' },
        },
      }),
    });
    const pages: Result<readonly Product[]>[] = await pagesOf(sameCursor);
    expect(pages).toHaveLength(3);
    expect(!pages[2]?.ok && pages[2]?.error.message).toContain('unchanged');
  });

  it('stops after maxPages', async () => {
    const scripted: ScriptedClient = scriptedClient({
      Products: productPages(100, 1),
    });
    const pages: Result<readonly Product[]>[] = await pagesOf(scripted, {
      maxPages: 3,
    });
    expect(pages).toHaveLength(4);
    expect(!pages[3]?.ok && pages[3]?.error.message).toContain('3 pages');
  });

  it('uses default names when none are given', async () => {
    const scripted: ScriptedClient = scriptedClient({
      PaginatedQuery: productPages(1, 2),
    });
    const pages: Result<readonly Product[]>[] = [];
    for await (const page of paginate<Data, Product>(scripted.client, '{ p }', {
      select,
    })) {
      pages.push(page);
    }
    expect(pages).toHaveLength(1);
  });
});

describe('collectNodes', () => {
  it('flattens every page', async () => {
    const scripted: ScriptedClient = scriptedClient({
      Products: productPages(5, 2),
    });
    const result: Result<Product[]> = await collectNodes<Data, Product>(
      scripted.client,
      '{ products }',
      { select, operationName: 'Products' }
    );
    expect(result.ok && result.value.map((item: Product) => item.id)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it('fails past maxItems and passes errors through', async () => {
    const scripted: ScriptedClient = scriptedClient({
      Products: productPages(10, 2),
    });
    const tooMany: Result<Product[]> = await collectNodes<Data, Product>(
      scripted.client,
      '{ products }',
      {
        select,
        operationName: 'Products',
        maxItems: 3,
      }
    );
    expect(!tooMany.ok && tooMany.error.message).toContain('maxItems (3)');
    const failing: ScriptedClient = scriptedClient({
      Products: () => new NetworkError('offline'),
    });
    expect(
      (
        await collectNodes<Data, Product>(failing.client, '{ p }', {
          select,
          operationName: 'Products',
        })
      ).ok
    ).toBe(false);
    const unnamed: ScriptedClient = scriptedClient({
      PaginatedQuery: productPages(4, 2),
    });
    const unnamedResult: Result<Product[]> = await collectNodes<Data, Product>(
      unnamed.client,
      '{ p }',
      { select, maxItems: 1 }
    );
    expect(!unnamedResult.ok && unnamedResult.error.message).toContain(
      'Paginated query'
    );
  });
});
