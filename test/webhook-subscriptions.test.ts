import { describe, expect, it } from 'vitest';

import {
  NetworkError,
  UserError,
  createWebhookSubscription,
  deleteWebhookSubscription,
  listWebhookSubscriptions,
  syncWebhookSubscriptions,
  updateWebhookSubscription,
  validateWebhookUri,
  type AdminClient,
  type AdminRequestOptions,
  type AdminResponse,
  type GraphqlDocument,
  type Result,
  type ShopifyError,
  type SyncReport,
  type WebhookSubscription,
  type WebhookSubscriptionSpec,
} from '../src/index.js';
import { err, ok } from '../src/index.js';

interface RecordedCall {
  readonly operation: string;
  readonly variables: Record<string, unknown>;
}

interface FakeAdmin {
  readonly client: AdminClient;
  readonly store: WebhookSubscription[];
  readonly calls: RecordedCall[];
  failWith: ShopifyError | undefined;
  userErrorsFor: string | undefined;
}

function subscription(
  id: string,
  topic: string,
  uri: string,
  extra: Partial<WebhookSubscription> = {}
): WebhookSubscription {
  return {
    id,
    topic,
    uri,
    filter: null,
    includeFields: [],
    metafieldNamespaces: [],
    ...extra,
  };
}

/** A tiny in-memory stand-in for the shop's webhookSubscriptions. */
function fakeAdmin(initial: WebhookSubscription[] = []): FakeAdmin {
  const store: WebhookSubscription[] = [...initial];
  const calls: RecordedCall[] = [];
  let counter: number = 100;
  const request = (
    document: GraphqlDocument,
    options: AdminRequestOptions = {}
  ): Promise<Result<AdminResponse<unknown>>> => {
    const operation: string = options.operationName ?? '';
    const variables: Record<string, unknown> = { ...(options.variables ?? {}) };
    calls.push({ operation, variables });
    const respond = (data: unknown): Promise<Result<AdminResponse<unknown>>> =>
      Promise.resolve(
        ok({ data, cost: undefined, requestId: undefined, attempts: 1 })
      );
    if (fake.failWith !== undefined) return Promise.resolve(err(fake.failWith));

    const input: Record<string, unknown> =
      (variables['webhookSubscription'] as
        Record<string, unknown> | undefined) ?? {};
    const userErrors: { message: string; field: string[] }[] =
      fake.userErrorsFor === operation
        ? [{ message: 'Address is invalid', field: ['uri'] }]
        : [];

    if (operation === 'WebhookSubscriptions') {
      const after: string | null = variables['after'] as string | null;
      const start: number = after === null ? 0 : Number(after);
      const nodes: WebhookSubscription[] = store.slice(start, start + 2);
      const next: number = start + 2;
      return respond({
        webhookSubscriptions: {
          nodes,
          pageInfo: {
            hasNextPage: next < store.length,
            endCursor: String(next),
          },
        },
      });
    }
    if (operation === 'WebhookSubscriptionCreate') {
      if (userErrors.length > 0) {
        return respond({
          webhookSubscriptionCreate: { webhookSubscription: null, userErrors },
        });
      }
      const created: WebhookSubscription = subscription(
        `gid://shopify/WebhookSubscription/${String(counter++)}`,
        variables['topic'] as string,
        input['uri'] as string,
        {
          filter: (input['filter'] as string | undefined) ?? null,
          includeFields: (input['includeFields'] as string[] | undefined) ?? [],
          metafieldNamespaces:
            (input['metafieldNamespaces'] as string[] | undefined) ?? [],
        }
      );
      store.push(created);
      return respond({
        webhookSubscriptionCreate: {
          webhookSubscription: created,
          userErrors: [],
        },
      });
    }
    if (operation === 'WebhookSubscriptionUpdate') {
      const index: number = store.findIndex(
        (item: WebhookSubscription): boolean => item.id === variables['id']
      );
      const current: WebhookSubscription | undefined = store[index];
      if (userErrors.length > 0 || current === undefined) {
        return respond({
          webhookSubscriptionUpdate: { webhookSubscription: null, userErrors },
        });
      }
      const updated: WebhookSubscription = {
        ...current,
        uri: input['uri'] as string,
        filter: (input['filter'] as string | undefined) ?? null,
        includeFields: (input['includeFields'] as string[] | undefined) ?? [],
        metafieldNamespaces:
          (input['metafieldNamespaces'] as string[] | undefined) ?? [],
      };
      store[index] = updated;
      return respond({
        webhookSubscriptionUpdate: {
          webhookSubscription: updated,
          userErrors: [],
        },
      });
    }
    // WebhookSubscriptionDelete
    const index: number = store.findIndex(
      (item: WebhookSubscription): boolean => item.id === variables['id']
    );
    if (userErrors.length === 0 && index >= 0) store.splice(index, 1);
    return respond({
      webhookSubscriptionDelete: {
        deletedWebhookSubscriptionId: variables['id'],
        userErrors,
      },
    });
  };

  const client: AdminClient = {
    shop: 'example.myshopify.com',
    apiVersion: '2026-10',
    request: request as AdminClient['request'],
  };
  const fake: FakeAdmin = {
    client,
    store,
    calls,
    failWith: undefined,
    userErrorsFor: undefined,
  };
  return fake;
}

const uri: string = 'https://app.example.com/webhooks';

describe('validateWebhookUri', () => {
  it.each([
    uri,
    'pubsub://my-project:my-topic',
    'arn:aws:events:us-east-1::event-source/aws.partner/shopify.com/1/x',
  ])('accepts %s', (value: string) => {
    expect(validateWebhookUri(value).ok).toBe(true);
  });

  it.each([
    'http://app.example.com/hook',
    'ftp://x',
    'not a uri',
    '',
    'https://',
  ])('refuses %j', (value: string) => {
    const result: Result<string, Error> = validateWebhookUri(value);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.message).toContain('Invalid webhook uri');
  });
});

describe('listWebhookSubscriptions', () => {
  it('follows pagination to the end', async () => {
    const fake: FakeAdmin = fakeAdmin([
      subscription('1', 'PRODUCTS_UPDATE', uri),
      subscription('2', 'ORDERS_PAID', uri),
      subscription('3', 'APP_UNINSTALLED', uri),
    ]);
    const result: Result<readonly WebhookSubscription[]> =
      await listWebhookSubscriptions(fake.client);
    expect(
      result.ok &&
        result.value.map((item: WebhookSubscription): string => item.id)
    ).toEqual(['1', '2', '3']);
    expect(
      fake.calls.map((call: RecordedCall): unknown => call.variables['after'])
    ).toEqual([null, '2']);
  });

  it('passes client failures through', async () => {
    const fake: FakeAdmin = fakeAdmin();
    fake.failWith = new NetworkError('offline');
    const result: Result<readonly WebhookSubscription[]> =
      await listWebhookSubscriptions(fake.client);
    expect(!result.ok && result.error.message).toBe('offline');
  });
});

describe('create, update and delete', () => {
  it('creates a subscription with the GraphQL topic and JSON format', async () => {
    const fake: FakeAdmin = fakeAdmin();
    const result: Result<WebhookSubscription> = await createWebhookSubscription(
      fake.client,
      {
        topic: 'products/update',
        uri,
        filter: 'vendor:Acme',
        includeFields: ['id', 'title'],
      }
    );
    expect(result.ok && result.value.topic).toBe('PRODUCTS_UPDATE');
    expect(fake.calls[0]?.variables).toEqual({
      topic: 'PRODUCTS_UPDATE',
      webhookSubscription: {
        uri,
        format: 'JSON',
        filter: 'vendor:Acme',
        includeFields: ['id', 'title'],
      },
    });
  });

  it('sends metafield namespaces when given', async () => {
    const fake: FakeAdmin = fakeAdmin();
    await createWebhookSubscription(fake.client, {
      topic: 'PRODUCTS_UPDATE',
      uri,
      metafieldNamespaces: ['custom'],
    });
    expect(fake.calls[0]?.variables['webhookSubscription']).toMatchObject({
      metafieldNamespaces: ['custom'],
    });
  });

  it('refuses a bad uri without calling Shopify', async () => {
    const fake: FakeAdmin = fakeAdmin();
    const created: Result<WebhookSubscription> =
      await createWebhookSubscription(fake.client, {
        topic: 't',
        uri: 'http://x.com',
      });
    const updated: Result<WebhookSubscription> =
      await updateWebhookSubscription(fake.client, '1', {
        topic: 't',
        uri: 'nope',
      });
    expect(created.ok || updated.ok).toBe(false);
    expect(fake.calls).toEqual([]);
  });

  it('turns userErrors into a UserError that names the operation', async () => {
    const fake: FakeAdmin = fakeAdmin([
      subscription('1', 'PRODUCTS_UPDATE', uri),
    ]);
    fake.userErrorsFor = 'WebhookSubscriptionCreate';
    const created: Result<WebhookSubscription> =
      await createWebhookSubscription(fake.client, {
        topic: 'orders/paid',
        uri,
      });
    expect(!created.ok && created.error).toBeInstanceOf(UserError);
    expect(!created.ok && created.error.message).toContain(
      'Address is invalid (uri)'
    );

    fake.userErrorsFor = 'WebhookSubscriptionUpdate';
    expect(
      (await updateWebhookSubscription(fake.client, '1', { topic: 'x', uri }))
        .ok
    ).toBe(false);
    fake.userErrorsFor = 'WebhookSubscriptionDelete';
    const deleted: Result<void> = await deleteWebhookSubscription(
      fake.client,
      '1'
    );
    expect(!deleted.ok && deleted.error.message).toContain(
      'Deleting the subscription'
    );
  });

  it('reports a missing subscription with no userErrors', async () => {
    const fake: FakeAdmin = fakeAdmin();
    const result: Result<WebhookSubscription> = await updateWebhookSubscription(
      fake.client,
      'missing',
      {
        topic: 'x',
        uri,
      }
    );
    expect(!result.ok && result.error.message).toContain('no subscription');
  });

  it('updates and deletes', async () => {
    const fake: FakeAdmin = fakeAdmin([
      subscription('1', 'PRODUCTS_UPDATE', uri),
    ]);
    const updated: Result<WebhookSubscription> =
      await updateWebhookSubscription(fake.client, '1', {
        topic: 'products/update',
        uri,
        filter: 'vendor:Acme',
      });
    expect(updated.ok && updated.value.filter).toBe('vendor:Acme');
    expect((await deleteWebhookSubscription(fake.client, '1')).ok).toBe(true);
    expect(fake.store).toEqual([]);
  });

  it('passes client failures through', async () => {
    const fake: FakeAdmin = fakeAdmin();
    fake.failWith = new NetworkError('offline');
    expect(
      (await createWebhookSubscription(fake.client, { topic: 'x', uri })).ok
    ).toBe(false);
    expect(
      (await updateWebhookSubscription(fake.client, '1', { topic: 'x', uri }))
        .ok
    ).toBe(false);
    expect((await deleteWebhookSubscription(fake.client, '1')).ok).toBe(false);
  });
});

describe('syncWebhookSubscriptions', () => {
  it('creates what is missing, updates what differs, leaves matches alone', async () => {
    const fake: FakeAdmin = fakeAdmin([
      subscription('1', 'PRODUCTS_UPDATE', uri, {
        includeFields: ['id', 'title'],
      }),
      subscription('2', 'ORDERS_PAID', uri),
      subscription('3', 'APP_UNINSTALLED', uri),
    ]);
    const result: Result<SyncReport> = await syncWebhookSubscriptions(
      fake.client,
      [
        { topic: 'products/update', uri, includeFields: ['title', 'id'] },
        { topic: 'orders/paid', uri, filter: 'financial_status:paid' },
        { topic: 'customers/redact', uri },
      ]
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.unchanged.map((item: WebhookSubscription): string => item.id)
    ).toEqual(['1']);
    expect(
      result.value.updated.map((item: WebhookSubscription): string => item.id)
    ).toEqual(['2']);
    expect(
      result.value.created.map(
        (item: WebhookSubscription): string => item.topic
      )
    ).toEqual(['CUSTOMERS_REDACT']);
    expect(result.value.deleted).toEqual([]);
    expect(
      fake.store.some((item: WebhookSubscription): boolean => item.id === '3')
    ).toBe(true);
  });

  it('deletes subscriptions that are not wanted only when asked', async () => {
    const fake: FakeAdmin = fakeAdmin([
      subscription('1', 'PRODUCTS_UPDATE', uri),
      subscription('2', 'ORDERS_PAID', uri),
    ]);
    const result: Result<SyncReport> = await syncWebhookSubscriptions(
      fake.client,
      [{ topic: 'products/update', uri }],
      { deleteExtra: true }
    );
    expect(
      result.ok &&
        result.value.deleted.map((item: WebhookSubscription): string => item.id)
    ).toEqual(['2']);
    expect(
      fake.store.map((item: WebhookSubscription): string => item.id)
    ).toEqual(['1']);
  });

  it('treats the same topic at another uri as a different subscription', async () => {
    const fake: FakeAdmin = fakeAdmin([
      subscription('1', 'PRODUCTS_UPDATE', 'https://old.example.com/hook'),
    ]);
    const result: Result<SyncReport> = await syncWebhookSubscriptions(
      fake.client,
      [{ topic: 'products/update', uri }]
    );
    expect(result.ok && result.value.created).toHaveLength(1);
    expect(fake.store).toHaveLength(2);
  });

  it('is idempotent', async () => {
    const fake: FakeAdmin = fakeAdmin();
    const desired: WebhookSubscriptionSpec[] = [
      { topic: 'products/update', uri },
      { topic: 'app/uninstalled', uri },
    ];
    await syncWebhookSubscriptions(fake.client, desired);
    const again: Result<SyncReport> = await syncWebhookSubscriptions(
      fake.client,
      desired
    );
    expect(again.ok && again.value.created).toEqual([]);
    expect(again.ok && again.value.unchanged).toHaveLength(2);
  });

  it('stops at the first failure and reports it', async () => {
    const fake: FakeAdmin = fakeAdmin([subscription('1', 'ORDERS_PAID', uri)]);
    fake.userErrorsFor = 'WebhookSubscriptionCreate';
    const result: Result<SyncReport> = await syncWebhookSubscriptions(
      fake.client,
      [
        { topic: 'products/update', uri },
        { topic: 'orders/paid', uri },
      ]
    );
    expect(!result.ok && result.error).toBeInstanceOf(UserError);

    fake.userErrorsFor = 'WebhookSubscriptionUpdate';
    const updateFails: Result<SyncReport> = await syncWebhookSubscriptions(
      fake.client,
      [{ topic: 'orders/paid', uri, filter: 'x:y' }]
    );
    expect(updateFails.ok).toBe(false);

    fake.userErrorsFor = 'WebhookSubscriptionDelete';
    const deleteFails: Result<SyncReport> = await syncWebhookSubscriptions(
      fake.client,
      [],
      { deleteExtra: true }
    );
    expect(deleteFails.ok).toBe(false);

    fake.failWith = new NetworkError('offline');
    expect((await syncWebhookSubscriptions(fake.client, [])).ok).toBe(false);
  });
});
