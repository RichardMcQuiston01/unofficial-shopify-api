/**
 * Writes to a real shop, so it is separate from `live-check` and refuses to
 * run until you opt in. It tags one product through a bulk mutation, confirms
 * the tag arrived, and removes the tag again. This exercises what mocked tests
 * cannot: the staged upload, the multipart file upload, the bulk mutation and
 * its result file.
 *
 *   SHOPIFY_SHOP=example SHOPIFY_API_VERSION=2026-10 SHOPIFY_ADMIN_TOKEN=shpat_... \
 *   LIVE_ALLOW_WRITES=yes npm run live-bulk-mutation
 *
 * Needs the `write_products` scope. Optional: LIVE_PRODUCT_ID (default: the
 * first product), LIVE_TAG (default: bulk-test), LIVE_KEEP_TAG=yes to leave the
 * tag in place. Use a development store.
 */
import { pathToFileURL } from 'node:url';
import {
  checkUserErrors,
  createAdminClient,
  runBulkMutation,
  streamBulkResults,
  type AdminClient,
  type AdminResponse,
  type BulkOperation,
  type BulkRow,
  type Result,
  type WithUserErrors,
} from '@richardmcquiston01/unofficial-shopify-api';
import {
  describeError,
  printLiveCheck,
  step,
  unwrap,
  withTokenFile,
  type Env,
  type LiveCheckResult,
} from './live-support.js';

export interface LiveBulkMutationOptions {
  /** Replaces the global `fetch` (tests only). */
  readonly fetch?: typeof fetch;
}

interface ProductSummary {
  readonly id: string;
  readonly title: string;
  readonly tags: readonly string[];
}

interface FirstProductData {
  readonly products: { readonly nodes: readonly ProductSummary[] };
}

interface ProductData {
  readonly product: ProductSummary | null;
}

interface TagsRemoveData {
  readonly tagsRemove: WithUserErrors;
}

const tagMutation: string = `mutation LiveTagProduct($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
}`;

const firstProductQuery: string = `query LiveBulkProduct {
  products(first: 1) { nodes { id title tags } }
}`;

const verifyQuery: string = `query LiveBulkVerify($id: ID!) {
  product(id: $id) { id title tags }
}`;

const removeMutation: string = `mutation LiveBulkCleanup($id: ID!, $tags: [String!]!) {
  tagsRemove(id: $id, tags: $tags) { userErrors { field message } }
}`;

/** Tags a product through a bulk mutation, checks the tag, and removes it. */
export async function runLiveBulkMutation(
  env: Env,
  options: LiveBulkMutationOptions = {}
): Promise<LiveCheckResult[]> {
  const results: LiveCheckResult[] = [];
  const fetchOption: { fetch?: typeof fetch } =
    options.fetch === undefined ? {} : { fetch: options.fetch };
  const shop: string = env['SHOPIFY_SHOP'] ?? '';
  const apiVersion: string = env['SHOPIFY_API_VERSION'] ?? '';
  const adminToken: string = env['SHOPIFY_ADMIN_TOKEN'] ?? '';
  const tag: string = env['LIVE_TAG'] ?? 'bulk-test';

  if (shop === '' || apiVersion === '' || adminToken === '') {
    return [
      {
        name: 'configuration',
        status: 'fail',
        detail:
          'Set SHOPIFY_SHOP, SHOPIFY_API_VERSION and SHOPIFY_ADMIN_TOKEN.',
      },
    ];
  }
  if (env['LIVE_ALLOW_WRITES'] !== 'yes') {
    return [
      {
        name: 'writes not allowed',
        status: 'fail',
        detail: `This check adds the tag "${tag}" to one product, then removes it. Use a development store, and set LIVE_ALLOW_WRITES=yes to go ahead.`,
      },
    ];
  }

  const created: Result<AdminClient> = createAdminClient({
    shop,
    apiVersion,
    accessToken: adminToken,
    ...fetchOption,
  });
  if (!created.ok) {
    return [
      {
        name: 'admin client',
        status: 'fail',
        detail: describeError(created.error),
      },
    ];
  }
  const client: AdminClient = created.value;

  let product: ProductSummary | undefined;
  await step(results, 'choose a product', async () => {
    const requested: string = env['LIVE_PRODUCT_ID'] ?? '';
    let found: ProductSummary | undefined;
    if (requested === '') {
      const response: AdminResponse<FirstProductData> = unwrap(
        await client.request<FirstProductData>(firstProductQuery, {
          operationName: 'LiveBulkProduct',
        })
      );
      found = response.data.products.nodes[0];
    } else {
      const response: AdminResponse<ProductData> = unwrap(
        await client.request<ProductData>(verifyQuery, {
          variables: { id: requested },
          operationName: 'LiveBulkVerify',
        })
      );
      found = response.data.product ?? undefined;
    }
    if (found === undefined) {
      throw new Error(
        'No product found to tag. Create a product on the development store, or set LIVE_PRODUCT_ID.'
      );
    }
    if (found.tags.includes(tag)) {
      throw new Error(
        `"${found.title}" already has the tag "${tag}". Set LIVE_TAG to a tag it does not have, so cleanup cannot remove a tag that was there before.`
      );
    }
    // Only set once the product is safe to change; nothing below runs otherwise.
    product = found;
    return `"${found.title}" (${found.id})`;
  });
  if (product === undefined) return results;
  const target: ProductSummary = product;

  await step(results, `bulk mutation: tagsAdd "${tag}"`, async () => {
    const done: BulkOperation = unwrap(
      await runBulkMutation(
        client,
        tagMutation,
        [{ id: target.id, tags: [tag] }],
        {
          timeoutMs: 10 * 60 * 1000,
          ...fetchOption,
          ...(options.fetch === undefined
            ? {}
            : { sleep: (): Promise<void> => Promise.resolve() }),
        }
      )
    );
    let rows: number = 0;
    for await (const row of streamBulkResults(done.url, fetchOption)) {
      const line: BulkRow = unwrap(row);
      rows += 1;
      const data: { tagsAdd?: WithUserErrors } | undefined = line['data'] as
        { tagsAdd?: WithUserErrors } | undefined;
      const userErrors: WithUserErrors['userErrors'] =
        data?.tagsAdd?.userErrors;
      if ((userErrors ?? []).length > 0) {
        throw new Error(
          `Shopify reported user errors for the tag: ${JSON.stringify(userErrors)}`
        );
      }
    }
    return `operation ${done.id} ${done.status}, ${String(rows)} result row(s)`;
  });

  await step(results, 'verify: the tag is on the product', async () => {
    const response: AdminResponse<ProductData> = unwrap(
      await client.request<ProductData>(verifyQuery, {
        variables: { id: target.id },
        operationName: 'LiveBulkVerify',
      })
    );
    const tags: readonly string[] = response.data.product?.tags ?? [];
    if (!tags.includes(tag)) {
      throw new Error(
        `The bulk operation completed, but "${tag}" is not on the product (tags: ${tags.join(', ') || 'none'}).`
      );
    }
    return `tags now: ${tags.join(', ')}`;
  });

  if (env['LIVE_KEEP_TAG'] === 'yes') {
    results.push({
      name: 'cleanup',
      status: 'skip',
      detail: `LIVE_KEEP_TAG=yes; "${tag}" left on the product.`,
    });
  } else {
    await step(results, 'cleanup: remove the tag', async () => {
      const response: AdminResponse<TagsRemoveData> = unwrap(
        await client.request<TagsRemoveData>(removeMutation, {
          variables: { id: target.id, tags: [tag] },
          operationName: 'LiveBulkCleanup',
        })
      );
      unwrap(checkUserErrors(response.data.tagsRemove, 'Removing the tag'));
      return `"${tag}" removed from "${target.title}"`;
    });
  }
  return results;
}

const entry: string | undefined = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = printLiveCheck(
    await runLiveBulkMutation(withTokenFile(process.env))
  );
}
