import { vi, type Mock } from 'vitest';

export interface FakeCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
  /** Parsed JSON for GraphQL calls, form fields for the token endpoint. */
  readonly json: Record<string, unknown> | undefined;
  readonly form: URLSearchParams | undefined;
}

export interface FakeShopifyOptions {
  readonly shop?: string;
  readonly apiVersion?: string;
  /** Respond 401 to every Admin GraphQL call. */
  readonly rejectAdmin?: boolean;
  /** Respond with this status to the token endpoint. */
  readonly tokenStatus?: number;
  /** Complete bulk mutations without applying them, so verification fails. */
  readonly ignoreBulkMutation?: boolean;
  /** Tags the first product starts with. */
  readonly productTags?: readonly string[];
}

export interface FakeShopify {
  readonly fetch: Mock<typeof fetch>;
  readonly calls: FakeCall[];
  readonly webhookSubscriptions: Record<string, unknown>[];
  /** The first product's tags, changed by bulk mutations and tagsRemove. */
  readonly productTags: string[];
  /** The JSONL last uploaded to the staged upload target. */
  readonly uploads: string[];
}

const json = (body: unknown, status: number = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-fake' },
  });

/** A small stand-in for Shopify: token endpoint, Admin and Storefront GraphQL, bulk results. */
export function fakeShopify(options: FakeShopifyOptions = {}): FakeShopify {
  const shop: string = options.shop ?? 'example.myshopify.com';
  const version: string = options.apiVersion ?? '2026-10';
  const calls: FakeCall[] = [];
  const webhookSubscriptions: Record<string, unknown>[] = [];
  const productTags: string[] = [...(options.productTags ?? [])];
  const uploads: string[] = [];
  let counter: number = 0;

  const bulkOperation = (
    status: string,
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> => ({
    id: 'gid://shopify/BulkOperation/1',
    status,
    type: 'QUERY',
    errorCode: null,
    createdAt: '2026-10-19T00:00:00Z',
    completedAt: status === 'COMPLETED' ? '2026-10-19T00:01:00Z' : null,
    objectCount: '3',
    rootObjectCount: '3',
    fileSize: '90',
    url:
      status === 'COMPLETED'
        ? 'https://storage.example.com/bulk.jsonl?sig=abc'
        : null,
    partialDataUrl: null,
    ...extra,
  });

  const handler = (
    input: URL | RequestInfo,
    init?: RequestInit
  ): Promise<Response> => {
    const url: string =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const body: string = typeof init?.body === 'string' ? init.body : '';
    const isForm: boolean =
      new Headers(init?.headers).get('content-type')?.includes('urlencoded') ===
      true;
    const call: FakeCall = {
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body,
      json:
        !isForm && body.startsWith('{')
          ? (JSON.parse(body) as Record<string, unknown>)
          : undefined,
      form: isForm ? new URLSearchParams(body) : undefined,
    };
    calls.push(call);
    const reply = (data: unknown): Promise<Response> =>
      Promise.resolve(json({ data }));

    if (url === `https://${shop}/admin/oauth/access_token`) {
      if (options.tokenStatus !== undefined)
        return Promise.resolve(json({ error: 'nope' }, options.tokenStatus));
      counter += 1;
      return Promise.resolve(
        json({
          access_token: `shpat_fake_${String(counter)}`,
          scope: 'read_products,write_products',
          expires_in: 3600,
          refresh_token: `shprt_fake_${String(counter)}`,
          refresh_token_expires_in: 7_776_000,
        })
      );
    }
    if (url === 'https://storage.example.com/bulk.jsonl?sig=abc') {
      return Promise.resolve(
        new Response(
          '{"id":"gid://shopify/Product/1","title":"Hat"}\n{"id":"gid://shopify/Product/2","title":"Scarf"}\n{"id":"gid://shopify/Product/3","title":"Mitten"}\n'
        )
      );
    }
    if (url === 'https://upload.example.com/bucket') {
      const file: FormDataEntryValue | null =
        init?.body instanceof FormData ? init.body.get('file') : null;
      const read: Promise<string> =
        file instanceof Blob ? file.text() : Promise.resolve('');
      return read.then((text: string): Response => {
        uploads.push(text);
        return new Response(null, { status: 201 });
      });
    }
    if (url === `https://${shop}/api/${version}/graphql.json`) {
      return reply({
        products: { nodes: [{ id: 'gid://shopify/Product/1' }] },
      });
    }
    if (url !== `https://${shop}/admin/api/${version}/graphql.json`) {
      return Promise.resolve(
        new Response(`unexpected URL ${url}`, { status: 404 })
      );
    }
    if (options.rejectAdmin === true)
      return Promise.resolve(
        new Response('Invalid API key or access token', { status: 401 })
      );

    const operationName: unknown = call.json?.['operationName'];
    const operation: string =
      typeof operationName === 'string' ? operationName : '';
    const variables: Record<string, unknown> =
      (call.json?.['variables'] as Record<string, unknown> | undefined) ?? {};
    switch (operation) {
      case 'LiveShop':
        return reply({ shop: { name: 'Fake Shop', myshopifyDomain: shop } });
      case 'LivePage':
      case 'Products': {
        const after: string | null = variables['after'] as string | null;
        return reply({
          products: {
            nodes: [
              {
                id: `gid://shopify/Product/${after === null ? '1' : '2'}`,
                title: after === null ? 'Hat' : 'Scarf',
              },
            ],
            pageInfo: {
              hasNextPage: after === null,
              endCursor: after === null ? 'c1' : null,
            },
          },
        });
      }
      case 'WebhookSubscriptions':
        return reply({
          webhookSubscriptions: {
            nodes: webhookSubscriptions,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        });
      case 'WebhookSubscriptionCreate': {
        const input: Record<string, unknown> = variables[
          'webhookSubscription'
        ] as Record<string, unknown>;
        const created: Record<string, unknown> = {
          id: `gid://shopify/WebhookSubscription/${String(webhookSubscriptions.length + 1)}`,
          topic: variables['topic'],
          uri: input['uri'],
          filter: null,
          includeFields: [],
          metafieldNamespaces: [],
        };
        webhookSubscriptions.push(created);
        return reply({
          webhookSubscriptionCreate: {
            webhookSubscription: created,
            userErrors: [],
          },
        });
      }
      case 'BulkOperationRunQuery':
        return reply({
          bulkOperationRunQuery: {
            bulkOperation: bulkOperation('CREATED'),
            userErrors: [],
          },
        });
      case 'DevRefreshShop':
        return reply({ shop: { name: 'Fake Shop' } });
      case 'LiveBulkProduct':
        return reply({
          products: {
            nodes: [
              {
                id: 'gid://shopify/Product/1',
                title: 'Hat',
                tags: productTags,
              },
            ],
          },
        });
      case 'LiveBulkVerify':
        return reply({
          product: {
            id: 'gid://shopify/Product/1',
            title: 'Hat',
            tags: productTags,
          },
        });
      case 'StagedUploadsCreate':
        return reply({
          stagedUploadsCreate: {
            stagedTargets: [
              {
                url: 'https://upload.example.com/bucket',
                resourceUrl: 'https://upload.example.com/bucket/x',
                parameters: [{ name: 'key', value: 'tmp/1/bulk/vars' }],
              },
            ],
            userErrors: [],
          },
        });
      case 'BulkOperationRunMutation': {
        if (options.ignoreBulkMutation !== true) {
          for (const line of uploads.at(-1)?.split('\n') ?? []) {
            if (line.trim() === '') continue;
            const parsed: { tags?: string[] } = JSON.parse(line) as {
              tags?: string[];
            };
            productTags.push(...(parsed.tags ?? []));
          }
        }
        return reply({
          bulkOperationRunMutation: {
            bulkOperation: bulkOperation('CREATED', { type: 'MUTATION' }),
            userErrors: [],
          },
        });
      }
      case 'LiveBulkCleanup': {
        const removed: string[] = variables['tags'] as string[];
        for (const tag of removed) {
          const index: number = productTags.indexOf(tag);
          if (index !== -1) productTags.splice(index, 1);
        }
        return reply({ tagsRemove: { userErrors: [] } });
      }
      case 'BulkOperationStatus':
        return reply({ node: bulkOperation('COMPLETED') });
      default:
        return Promise.resolve(
          json({
            errors: [{ message: `fake Shopify has no operation ${operation}` }],
          })
        );
    }
  };

  const mock: Mock<typeof fetch> = vi.fn<typeof fetch>(handler);
  return { fetch: mock, calls, webhookSubscriptions, productTags, uploads };
}
