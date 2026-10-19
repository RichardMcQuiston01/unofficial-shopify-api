import type { AdminClient } from '../client/admin-client.js';
import type { AdminResponse } from '../client/types.js';
import { checkUserErrors } from '../client/user-errors.js';
import {
  ConfigurationError,
  type UserError,
  type UserErrorDetail,
} from '../errors/errors.js';
import { err, ok, type Result } from '../result/result.js';
import { toGraphqlTopic } from './topics.js';

/** A webhook subscription stored in the shop. */
export interface WebhookSubscription {
  readonly id: string;
  /** GraphQL enum spelling, such as `PRODUCTS_UPDATE`. */
  readonly topic: string;
  readonly uri: string;
  readonly filter: string | null;
  readonly includeFields: readonly string[];
  readonly metafieldNamespaces: readonly string[];
}

/** What you want to exist. Topics may be `products/update` or `PRODUCTS_UPDATE`. */
export interface WebhookSubscriptionSpec {
  readonly topic: string;
  /** An HTTPS URL, `pubsub://project:topic`, or an EventBridge ARN. */
  readonly uri: string;
  /** Shopify search syntax, such as `vendor:Acme`. */
  readonly filter?: string;
  /** Limit the payload to these fields; omit for all fields. */
  readonly includeFields?: readonly string[];
  readonly metafieldNamespaces?: readonly string[];
}

const subscriptionFields: string = `
  id
  topic
  uri
  filter
  includeFields
  metafieldNamespaces
`;

const listQuery: string = `
  query WebhookSubscriptions($after: String) {
    webhookSubscriptions(first: 100, after: $after) {
      nodes {${subscriptionFields}}
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const createMutation: string = `
  mutation WebhookSubscriptionCreate(
    $topic: WebhookSubscriptionTopic!
    $webhookSubscription: WebhookSubscriptionInput!
  ) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
      webhookSubscription {${subscriptionFields}}
      userErrors { field message }
    }
  }
`;

const updateMutation: string = `
  mutation WebhookSubscriptionUpdate(
    $id: ID!
    $webhookSubscription: WebhookSubscriptionInput!
  ) {
    webhookSubscriptionUpdate(id: $id, webhookSubscription: $webhookSubscription) {
      webhookSubscription {${subscriptionFields}}
      userErrors { field message }
    }
  }
`;

const deleteMutation: string = `
  mutation WebhookSubscriptionDelete($id: ID!) {
    webhookSubscriptionDelete(id: $id) {
      deletedWebhookSubscriptionId
      userErrors { field message }
    }
  }
`;

interface ListData {
  readonly webhookSubscriptions: {
    readonly nodes: readonly WebhookSubscription[];
    readonly pageInfo: {
      readonly hasNextPage: boolean;
      readonly endCursor: string | null;
    };
  };
}

interface SubscriptionPayloadData {
  readonly webhookSubscription: WebhookSubscription | null;
  readonly userErrors: readonly UserErrorDetail[];
}

function subscriptionInput(
  spec: WebhookSubscriptionSpec
): Record<string, unknown> {
  return {
    uri: spec.uri,
    format: 'JSON',
    ...(spec.filter === undefined ? {} : { filter: spec.filter }),
    ...(spec.includeFields === undefined
      ? {}
      : { includeFields: spec.includeFields }),
    ...(spec.metafieldNamespaces === undefined
      ? {}
      : { metafieldNamespaces: spec.metafieldNamespaces }),
  };
}

/** Delivery targets Shopify accepts: HTTPS, Google Pub/Sub or Amazon EventBridge. */
export function validateWebhookUri(
  uri: string
): Result<string, ConfigurationError> {
  if (
    /^https:\/\/[^\s/]+/.test(uri) ||
    /^pubsub:\/\/[^\s:]+:[^\s:]+$/.test(uri) ||
    /^arn:aws:events:/.test(uri)
  ) {
    return ok(uri);
  }
  return err(
    new ConfigurationError(
      `Invalid webhook uri "${uri}": use an https:// URL, pubsub://<project>:<topic>, or an EventBridge ARN.`
    )
  );
}

/** Lists every webhook subscription this app created in the shop. */
export async function listWebhookSubscriptions(
  client: AdminClient
): Promise<Result<readonly WebhookSubscription[]>> {
  const subscriptions: WebhookSubscription[] = [];
  let after: string | null = null;
  for (;;) {
    const page: Result<AdminResponse<ListData>> =
      await client.request<ListData>(listQuery, {
        variables: { after },
        operationName: 'WebhookSubscriptions',
      });
    if (!page.ok) return page;
    const connection: ListData['webhookSubscriptions'] =
      page.value.data.webhookSubscriptions;
    subscriptions.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) return ok(subscriptions);
    after = connection.pageInfo.endCursor;
  }
}

/** Creates one subscription. */
export async function createWebhookSubscription(
  client: AdminClient,
  spec: WebhookSubscriptionSpec
): Promise<Result<WebhookSubscription>> {
  const uri: Result<string, ConfigurationError> = validateWebhookUri(spec.uri);
  if (!uri.ok) return uri;
  const response: Result<
    AdminResponse<{ webhookSubscriptionCreate: SubscriptionPayloadData }>
  > = await client.request<{
    webhookSubscriptionCreate: SubscriptionPayloadData;
  }>(createMutation, {
    variables: {
      topic: toGraphqlTopic(spec.topic),
      webhookSubscription: subscriptionInput(spec),
    },
    operationName: 'WebhookSubscriptionCreate',
  });
  return unwrapSubscription(
    response,
    'webhookSubscriptionCreate',
    'Creating the subscription'
  );
}

/** Replaces the settings of an existing subscription. */
export async function updateWebhookSubscription(
  client: AdminClient,
  id: string,
  spec: WebhookSubscriptionSpec
): Promise<Result<WebhookSubscription>> {
  const uri: Result<string, ConfigurationError> = validateWebhookUri(spec.uri);
  if (!uri.ok) return uri;
  const response: Result<
    AdminResponse<{ webhookSubscriptionUpdate: SubscriptionPayloadData }>
  > = await client.request<{
    webhookSubscriptionUpdate: SubscriptionPayloadData;
  }>(updateMutation, {
    variables: { id, webhookSubscription: subscriptionInput(spec) },
    operationName: 'WebhookSubscriptionUpdate',
  });
  return unwrapSubscription(
    response,
    'webhookSubscriptionUpdate',
    'Updating the subscription'
  );
}

/** Deletes a subscription by its GraphQL ID. */
export async function deleteWebhookSubscription(
  client: AdminClient,
  id: string
): Promise<Result<void>> {
  const response: Result<
    AdminResponse<{
      webhookSubscriptionDelete: { userErrors: readonly UserErrorDetail[] };
    }>
  > = await client.request<{
    webhookSubscriptionDelete: { userErrors: readonly UserErrorDetail[] };
  }>(deleteMutation, {
    variables: { id },
    operationName: 'WebhookSubscriptionDelete',
  });
  if (!response.ok) return response;
  const checked: Result<{ userErrors: readonly UserErrorDetail[] }, UserError> =
    checkUserErrors(
      response.value.data.webhookSubscriptionDelete,
      'Deleting the subscription'
    );
  return checked.ok ? ok(undefined) : checked;
}

function unwrapSubscription<TKey extends string>(
  response: Result<AdminResponse<Record<TKey, SubscriptionPayloadData>>>,
  key: TKey,
  operation: string
): Result<WebhookSubscription> {
  if (!response.ok) return response;
  const payload: SubscriptionPayloadData = response.value.data[key];
  const checked: Result<SubscriptionPayloadData, UserError> = checkUserErrors(
    payload,
    operation
  );
  if (!checked.ok) return checked;
  if (payload.webhookSubscription === null) {
    return err(
      new ConfigurationError(
        `${operation} returned no subscription and no userErrors.`
      )
    );
  }
  return ok(payload.webhookSubscription);
}

/** What `syncWebhookSubscriptions` did. */
export interface SyncReport {
  readonly created: readonly WebhookSubscription[];
  readonly updated: readonly WebhookSubscription[];
  readonly deleted: readonly WebhookSubscription[];
  readonly unchanged: readonly WebhookSubscription[];
}

export interface SyncOptions {
  /** Also delete subscriptions that are not in `desired`. Default false. */
  readonly deleteExtra?: boolean;
}

const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length &&
  [...left]
    .sort()
    .every(
      (item: string, index: number): boolean =>
        item === [...right].sort()[index]
    );

function differs(
  existing: WebhookSubscription,
  spec: WebhookSubscriptionSpec
): boolean {
  return (
    (existing.filter ?? '') !== (spec.filter ?? '') ||
    !sameSet(existing.includeFields, spec.includeFields ?? []) ||
    !sameSet(existing.metafieldNamespaces, spec.metafieldNamespaces ?? [])
  );
}

/**
 * Makes the shop's subscriptions match `desired`. A subscription is
 * identified by topic + uri: missing ones are created, ones with different
 * settings are updated, matching ones are left alone. Duplicates of a desired
 * subscription are never touched unless `deleteExtra` is set. Stops at the
 * first failure and reports it; running it again continues safely.
 */
export async function syncWebhookSubscriptions(
  client: AdminClient,
  desired: readonly WebhookSubscriptionSpec[],
  options: SyncOptions = {}
): Promise<Result<SyncReport>> {
  const existing: Result<readonly WebhookSubscription[]> =
    await listWebhookSubscriptions(client);
  if (!existing.ok) return existing;

  const created: WebhookSubscription[] = [];
  const updated: WebhookSubscription[] = [];
  const unchanged: WebhookSubscription[] = [];
  const deleted: WebhookSubscription[] = [];
  const matched: Set<string> = new Set<string>();

  for (const spec of desired) {
    const topic: string = toGraphqlTopic(spec.topic);
    const current: WebhookSubscription | undefined = existing.value.find(
      (subscription: WebhookSubscription): boolean =>
        !matched.has(subscription.id) &&
        subscription.topic === topic &&
        subscription.uri === spec.uri
    );
    if (current === undefined) {
      const result: Result<WebhookSubscription> =
        await createWebhookSubscription(client, spec);
      if (!result.ok) return result;
      created.push(result.value);
      continue;
    }
    matched.add(current.id);
    if (!differs(current, spec)) {
      unchanged.push(current);
      continue;
    }
    const result: Result<WebhookSubscription> = await updateWebhookSubscription(
      client,
      current.id,
      spec
    );
    if (!result.ok) return result;
    updated.push(result.value);
  }

  if (options.deleteExtra === true) {
    for (const subscription of existing.value) {
      if (matched.has(subscription.id)) continue;
      const result: Result<void> = await deleteWebhookSubscription(
        client,
        subscription.id
      );
      if (!result.ok) return result;
      deleted.push(subscription);
    }
  }
  return ok({ created, updated, deleted, unchanged });
}
