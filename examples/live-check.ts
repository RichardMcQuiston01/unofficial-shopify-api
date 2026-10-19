/**
 * Read-only smoke test against a real shop, to confirm what unit tests with a
 * mocked `fetch` cannot: that Shopify accepts our requests and answers the way
 * the library expects. It changes nothing in the shop.
 *
 *   SHOPIFY_SHOP=example SHOPIFY_API_VERSION=2026-10 SHOPIFY_ADMIN_TOKEN=shpat_... \
 *     npm run live-check
 *
 * Optional: STOREFRONT_PUBLIC_TOKEN or STOREFRONT_PRIVATE_TOKEN (otherwise a
 * tokenless Storefront request is tried), LIVE_BULK_QUERY (default: products).
 * The OAuth install and webhook delivery need a browser and a public URL; see
 * docs/LIVE-TESTING.md for those steps.
 */
import { pathToFileURL } from 'node:url';
import {
  createAdminClient,
  createStorefrontClient,
  listWebhookSubscriptions,
  paginate,
  runBulkQuery,
  streamBulkResults,
  type AdminClient,
  type AdminResponse,
  type BulkOperation,
  type PageInfo,
  type Result,
  type StorefrontClient,
  type WebhookSubscription,
} from '@richardmcquiston01/unofficial-shopify-api';
import {
  describeError,
  printLiveCheck,
  step,
  unwrap,
  type Env,
  type LiveCheckResult,
} from './live-support.js';

export { printLiveCheck, type LiveCheckResult };

export interface LiveCheckOptions {
  /** Replaces the global `fetch` (tests only). */
  readonly fetch?: typeof fetch;
}

const defaultBulkQuery: string = '{ products { edges { node { id title } } } }';

interface ShopData {
  readonly shop: { readonly name: string; readonly myshopifyDomain: string };
}

interface StorefrontData {
  readonly products: { readonly nodes: readonly { readonly id: string }[] };
}

interface ProductsPage {
  readonly products: {
    readonly nodes: readonly { readonly id: string }[];
    readonly pageInfo: PageInfo;
  };
}

/** Runs every check that the environment allows and returns the outcomes. */
export async function runLiveCheck(
  env: Env,
  options: LiveCheckOptions = {}
): Promise<LiveCheckResult[]> {
  const results: LiveCheckResult[] = [];
  const fetchOption: { fetch?: typeof fetch } =
    options.fetch === undefined ? {} : { fetch: options.fetch };
  const shop: string = env['SHOPIFY_SHOP'] ?? '';
  const apiVersion: string = env['SHOPIFY_API_VERSION'] ?? '';
  const adminToken: string = env['SHOPIFY_ADMIN_TOKEN'] ?? '';

  if (shop === '' || apiVersion === '') {
    return [
      {
        name: 'configuration',
        status: 'fail',
        detail:
          'Set SHOPIFY_SHOP and SHOPIFY_API_VERSION (and SHOPIFY_ADMIN_TOKEN for the Admin checks).',
      },
    ];
  }

  if (adminToken === '') {
    results.push({
      name: 'admin checks',
      status: 'skip',
      detail: 'SHOPIFY_ADMIN_TOKEN is not set.',
    });
  } else {
    const created: Result<AdminClient> = createAdminClient({
      shop,
      apiVersion,
      accessToken: adminToken,
      ...fetchOption,
    });
    if (!created.ok) {
      results.push({
        name: 'admin client',
        status: 'fail',
        detail: describeError(created.error),
      });
    } else {
      const client: AdminClient = created.value;

      await step(results, 'admin: shop query', async () => {
        const response: AdminResponse<ShopData> = unwrap(
          await client.request<ShopData>(
            'query LiveShop { shop { name myshopifyDomain } }',
            { operationName: 'LiveShop' }
          )
        );
        return `${response.data.shop.name} (${response.data.shop.myshopifyDomain}), request ${response.requestId ?? 'n/a'}`;
      });

      await step(
        results,
        'admin: pagination (2 pages of 5 products)',
        async () => {
          let pages: number = 0;
          let products: number = 0;
          for await (const page of paginate<ProductsPage, { id: string }>(
            client,
            `query LivePage($after: String) {
            products(first: 5, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } }
          }`,
            {
              select: (data: ProductsPage) => data.products,
              operationName: 'LivePage',
              maxPages: 2,
            }
          )) {
            if (!page.ok) {
              // Hitting the page cap is expected on a shop with more than 10 products.
              if (page.error.code === 'PAGINATION' && pages === 2) break;
              throw new Error(describeError(page.error));
            }
            pages += 1;
            products += page.value.length;
          }
          return `${String(pages)} page(s), ${String(products)} product(s)`;
        }
      );

      await step(results, 'admin: webhook subscriptions', async () => {
        const subscriptions: readonly WebhookSubscription[] = unwrap(
          await listWebhookSubscriptions(client)
        );
        return `${String(subscriptions.length)} subscription(s)`;
      });

      await step(results, 'admin: bulk query + streamed results', async () => {
        const done: BulkOperation = unwrap(
          await runBulkQuery(
            client,
            env['LIVE_BULK_QUERY'] ?? defaultBulkQuery,
            {
              timeoutMs: 10 * 60 * 1000,
              ...(options.fetch === undefined
                ? {}
                : { sleep: (): Promise<void> => Promise.resolve() }),
            }
          )
        );
        let rows: number = 0;
        for await (const row of streamBulkResults(done.url, fetchOption)) {
          unwrap(row);
          rows += 1;
        }
        return `operation ${done.id} completed, ${String(done.objectCount)} objects, ${String(rows)} row(s) read`;
      });
    }
  }

  const publicToken: string = env['STOREFRONT_PUBLIC_TOKEN'] ?? '';
  const privateToken: string = env['STOREFRONT_PRIVATE_TOKEN'] ?? '';
  const flavor: string =
    publicToken !== ''
      ? 'public token'
      : privateToken !== ''
        ? 'private token'
        : 'tokenless';
  const storefront: Result<StorefrontClient> = createStorefrontClient({
    shop,
    apiVersion,
    ...(publicToken !== '' ? { publicAccessToken: publicToken } : {}),
    ...(publicToken === '' && privateToken !== ''
      ? { privateAccessToken: privateToken }
      : {}),
    ...fetchOption,
  });
  if (!storefront.ok) {
    results.push({
      name: 'storefront client',
      status: 'fail',
      detail: describeError(storefront.error),
    });
  } else {
    await step(results, `storefront: products query (${flavor})`, async () => {
      const response: AdminResponse<StorefrontData> = unwrap(
        await storefront.value.request<StorefrontData>(
          'query LiveStorefront { products(first: 1) { nodes { id } } }',
          { operationName: 'LiveStorefront' }
        )
      );
      return `${String(response.data.products.nodes.length)} product(s) visible`;
    });
  }
  return results;
}

const entry: string | undefined = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = printLiveCheck(await runLiveCheck(process.env));
}
