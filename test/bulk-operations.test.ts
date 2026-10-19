import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  BulkOperationError,
  NetworkError,
  UserError,
  cancelBulkOperation,
  getBulkOperation,
  runBulkMutation,
  runBulkQuery,
  stageBulkMutationInput,
  startBulkMutation,
  startBulkQuery,
  waitForBulkOperation,
  type BulkOperation,
  type Result,
  type ShopifyError,
} from '../src/index.js';
import {
  scriptedClient,
  type Responder,
  type ScriptedClient,
} from './helpers.js';

interface StagedTargetFixture {
  readonly url: string;
  readonly resourceUrl: string;
  readonly parameters: readonly { name: string; value: string }[];
}

const bulkId: string = 'gid://shopify/BulkOperation/1';

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: bulkId,
    status: 'RUNNING',
    type: 'QUERY',
    errorCode: null,
    createdAt: '2026-10-19T00:00:00Z',
    completedAt: null,
    objectCount: '12',
    rootObjectCount: '4',
    fileSize: null,
    url: null,
    partialDataUrl: null,
    ...overrides,
  };
}

const started =
  (payload: Record<string, unknown>): Responder =>
  (): unknown =>
    payload;

type Run = Result<BulkOperation>;

function failureOf(result: Result<unknown>): ShopifyError {
  if (result.ok) throw new Error('Expected an Err result.');
  return result.error;
}

describe('startBulkQuery', () => {
  const query: string = '{ products { edges { node { id } } } }';

  it('starts the query and converts counters to numbers', async () => {
    const scripted: ScriptedClient = scriptedClient({
      BulkOperationRunQuery: started({
        bulkOperationRunQuery: {
          bulkOperation: raw({ fileSize: '2048' }),
          userErrors: [],
        },
      }),
    });
    const result: Run = await startBulkQuery(scripted.client, query);
    expect(result.ok && result.value).toMatchObject({
      id: bulkId,
      status: 'RUNNING',
      objectCount: 12,
      rootObjectCount: 4,
      fileSize: 2048,
    });
    expect(scripted.calls[0]?.variables).toEqual({ query });
    expect(scripted.calls[0]?.document).not.toContain('groupObjects');
  });

  it('sends groupObjects only when asked', async () => {
    const scripted: ScriptedClient = scriptedClient({
      BulkOperationRunQuery: started({
        bulkOperationRunQuery: { bulkOperation: raw(), userErrors: [] },
      }),
    });
    await startBulkQuery(scripted.client, query, { groupObjects: false });
    expect(scripted.calls[0]?.variables).toEqual({
      query,
      groupObjects: false,
    });
    expect(scripted.calls[0]?.document).toContain(
      'groupObjects: $groupObjects'
    );
  });

  it('turns userErrors into a UserError', async () => {
    const scripted: ScriptedClient = scriptedClient({
      BulkOperationRunQuery: started({
        bulkOperationRunQuery: {
          bulkOperation: null,
          userErrors: [
            {
              field: null,
              message: 'A bulk query operation is already in progress.',
              code: 'OPERATION_IN_PROGRESS',
            },
          ],
        },
      }),
    });
    const error: ShopifyError = failureOf(
      await startBulkQuery(scripted.client, query)
    );
    expect(error).toBeInstanceOf(UserError);
    expect(error.message).toContain('already in progress');
  });

  it('reports a payload with no operation and no errors, and client failures', async () => {
    const empty: ScriptedClient = scriptedClient({
      BulkOperationRunQuery: started({
        bulkOperationRunQuery: { bulkOperation: null, userErrors: [] },
      }),
    });
    expect(
      failureOf(await startBulkQuery(empty.client, query)).message
    ).toContain('no bulk operation');
    const missing: ScriptedClient = scriptedClient({
      BulkOperationRunQuery: started({}),
    });
    expect(
      failureOf(await startBulkQuery(missing.client, query)).message
    ).toContain('no bulkOperationRunQuery payload');
    const down: ScriptedClient = scriptedClient({
      BulkOperationRunQuery: () => new NetworkError('offline'),
    });
    expect((await startBulkQuery(down.client, query)).ok).toBe(false);
  });
});

describe('getBulkOperation and cancelBulkOperation', () => {
  it('reads an operation through node()', async () => {
    const scripted: ScriptedClient = scriptedClient({
      BulkOperationStatus: started({
        node: raw({
          status: 'COMPLETED',
          url: 'https://x/y.jsonl',
          fileSize: '10',
        }),
      }),
    });
    const result: Run = await getBulkOperation(scripted.client, bulkId);
    expect(result.ok && result.value.status).toBe('COMPLETED');
    expect(scripted.calls[0]?.document).toContain('node(id: $id)');
    expect(scripted.calls[0]?.document).toContain('... on BulkOperation');
  });

  it('reports an unknown ID or a node of another type', async () => {
    const missing: ScriptedClient = scriptedClient({
      BulkOperationStatus: started({ node: null }),
    });
    const error: ShopifyError = failureOf(
      await getBulkOperation(missing.client, bulkId)
    );
    expect(error).toBeInstanceOf(BulkOperationError);
    expect((error as BulkOperationError).status).toBe('NOT_FOUND');
    const other: ScriptedClient = scriptedClient({
      BulkOperationStatus: started({ node: {} }),
    });
    expect(
      (await getBulkOperation(other.client, 'gid://shopify/Product/1')).ok
    ).toBe(false);
    const down: ScriptedClient = scriptedClient({
      BulkOperationStatus: () => new NetworkError('offline'),
    });
    expect((await getBulkOperation(down.client, bulkId)).ok).toBe(false);
  });

  it('cancels', async () => {
    const scripted: ScriptedClient = scriptedClient({
      BulkOperationCancel: started({
        bulkOperationCancel: {
          bulkOperation: raw({ status: 'CANCELING' }),
          userErrors: [],
        },
      }),
    });
    const result: Run = await cancelBulkOperation(scripted.client, bulkId);
    expect(result.ok && result.value.status).toBe('CANCELING');
  });
});

describe('waitForBulkOperation', () => {
  function statuses(...list: Record<string, unknown>[]): ScriptedClient {
    return scriptedClient({
      BulkOperationStatus: (
        variables: Record<string, unknown>,
        callNumber: number
      ): unknown => ({
        node: list[Math.min(callNumber, list.length - 1)],
      }),
    });
  }

  it('polls with growing waits until completion and reports progress', async () => {
    const scripted: ScriptedClient = statuses(
      raw({ objectCount: '1' }),
      raw({ objectCount: '5' }),
      raw({ objectCount: '9' }),
      raw({ status: 'COMPLETED', objectCount: '12', url: 'https://x/y.jsonl' })
    );
    const sleeps: number[] = [];
    const progress: number[] = [];
    const result: Run = await waitForBulkOperation(scripted.client, bulkId, {
      sleep: (milliseconds: number): Promise<void> => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
      onProgress: (operation: BulkOperation): void =>
        void progress.push(operation.objectCount),
    });
    expect(result.ok && result.value.url).toBe('https://x/y.jsonl');
    expect(sleeps).toEqual([2000, 3000, 4500]);
    expect(progress).toEqual([1, 5, 9, 12]);
  });

  it('caps the wait at maxPollIntervalMs', async () => {
    const scripted: ScriptedClient = statuses(
      raw(),
      raw(),
      raw(),
      raw(),
      raw({ status: 'COMPLETED' })
    );
    const sleeps: number[] = [];
    await waitForBulkOperation(scripted.client, bulkId, {
      pollIntervalMs: 4000,
      maxPollIntervalMs: 5000,
      sleep: (milliseconds: number): Promise<void> => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
    });
    expect(sleeps).toEqual([4000, 5000, 5000, 5000]);
  });

  it.each(['FAILED', 'CANCELED', 'EXPIRED'])(
    'turns %s into a BulkOperationError',
    async (status: string) => {
      const scripted: ScriptedClient = statuses(
        raw({
          status,
          errorCode: status === 'FAILED' ? 'TIMEOUT' : null,
          partialDataUrl:
            status === 'FAILED' ? 'https://x/partial.jsonl' : null,
        })
      );
      const error: ShopifyError = failureOf(
        await waitForBulkOperation(scripted.client, bulkId, {
          sleep: () => Promise.resolve(),
        })
      );
      expect(error).toBeInstanceOf(BulkOperationError);
      const bulk: BulkOperationError = error as BulkOperationError;
      expect(bulk.status).toBe(status);
      expect(bulk.bulkOperationId).toBe(bulkId);
      expect(error.message).toContain(status);
      if (status === 'FAILED') {
        expect(bulk.errorCode).toBe('TIMEOUT');
        expect(bulk.partialDataUrl).toBe('https://x/partial.jsonl');
        expect(error.message).toContain('partialDataUrl');
      }
    }
  );

  it('stops waiting at the timeout and says the operation keeps running', async () => {
    const scripted: ScriptedClient = statuses(raw());
    let clock: number = 0;
    const error: ShopifyError = failureOf(
      await waitForBulkOperation(scripted.client, bulkId, {
        timeoutMs: 5000,
        now: (): number => clock,
        sleep: (milliseconds: number): Promise<void> => {
          clock += milliseconds;
          return Promise.resolve();
        },
      })
    );
    expect(error).toBeInstanceOf(BulkOperationError);
    expect(error.message).toContain('keeps running');
    expect(error.message).toContain('cancelBulkOperation');
  });

  it('reports an abort while waiting, and failures reading the status', async () => {
    const scripted: ScriptedClient = statuses(raw());
    const aborted: ShopifyError = failureOf(
      await waitForBulkOperation(scripted.client, bulkId, {
        sleep: () => Promise.reject(new Error('aborted')),
      })
    );
    expect(aborted).toBeInstanceOf(NetworkError);
    const down: ScriptedClient = scriptedClient({
      BulkOperationStatus: () => new NetworkError('offline'),
    });
    expect((await waitForBulkOperation(down.client, bulkId)).ok).toBe(false);
  });

  it('passes the abort signal to every status read', async () => {
    const scripted: ScriptedClient = statuses(raw({ status: 'COMPLETED' }));
    const controller: AbortController = new AbortController();
    await waitForBulkOperation(scripted.client, bulkId, {
      signal: controller.signal,
    });
    expect(scripted.calls).toHaveLength(1);
  });
});

describe('runBulkQuery', () => {
  it('starts and waits', async () => {
    const scripted: ScriptedClient = scriptedClient({
      BulkOperationRunQuery: started({
        bulkOperationRunQuery: { bulkOperation: raw(), userErrors: [] },
      }),
      BulkOperationStatus: started({
        node: raw({ status: 'COMPLETED', url: 'https://x/y.jsonl' }),
      }),
    });
    const result: Run = await runBulkQuery(
      scripted.client,
      '{ products { edges { node { id } } } }'
    );
    expect(result.ok && result.value.status).toBe('COMPLETED');
    expect(scripted.calls.map((call) => call.operation)).toEqual([
      'BulkOperationRunQuery',
      'BulkOperationStatus',
    ]);
  });

  it('does not wait when starting fails', async () => {
    const scripted: ScriptedClient = scriptedClient({
      BulkOperationRunQuery: () => new NetworkError('offline'),
    });
    expect((await runBulkQuery(scripted.client, '{ a }')).ok).toBe(false);
    expect(scripted.calls).toHaveLength(1);
  });
});

describe('bulk mutations', () => {
  const stagedPath: string = 'tmp/1/bulk/abc/bulk_op_vars';
  const target: StagedTargetFixture = {
    url: 'https://upload.example.com/bucket',
    resourceUrl: 'https://upload.example.com/bucket/x',
    parameters: [
      { name: 'key', value: stagedPath },
      { name: 'policy', value: 'POLICY' },
      { name: 'x-goog-signature', value: 'SIG' },
    ],
  };
  const staged: Responder = started({
    stagedUploadsCreate: { stagedTargets: [target], userErrors: [] },
  });

  function uploadMock(
    response: Response | Error = new Response(null, { status: 201 })
  ): Mock<typeof fetch> {
    return vi.fn<typeof fetch>(() =>
      response instanceof Error
        ? Promise.reject(response)
        : Promise.resolve(response)
    );
  }

  it('uploads JSONL as multipart with the signed fields first and the file last', async () => {
    const scripted: ScriptedClient = scriptedClient({
      StagedUploadsCreate: staged,
    });
    const upload: Mock<typeof fetch> = uploadMock();
    const result: Result<string> = await stageBulkMutationInput(
      scripted.client,
      [{ input: { title: 'A' } }, { input: { title: 'B' } }],
      { fetch: upload }
    );
    expect(result).toEqual({ ok: true, value: stagedPath });
    expect(scripted.calls[0]?.variables).toEqual({
      input: [
        {
          resource: 'BULK_MUTATION_VARIABLES',
          filename: 'bulk_op_vars',
          mimeType: 'text/jsonl',
          httpMethod: 'POST',
        },
      ],
    });
    const [url, init]: Parameters<typeof fetch> = upload.mock
      .calls[0] as Parameters<typeof fetch>;
    expect(url).toBe('https://upload.example.com/bucket');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toBeUndefined();
    const form: FormData = init?.body as FormData;
    expect([...form.keys()]).toEqual([
      'key',
      'policy',
      'x-goog-signature',
      'file',
    ]);
    expect(await (form.get('file') as File).text()).toBe(
      '{"input":{"title":"A"}}\n{"input":{"title":"B"}}'
    );
  });

  it('accepts a ready-made JSONL string', async () => {
    const scripted: ScriptedClient = scriptedClient({
      StagedUploadsCreate: staged,
    });
    const upload: Mock<typeof fetch> = uploadMock();
    await stageBulkMutationInput(scripted.client, '{"a":1}\n{"a":2}', {
      fetch: upload,
    });
    expect(
      await (
        (upload.mock.calls[0]?.[1]?.body as FormData).get('file') as File
      ).text()
    ).toBe('{"a":1}\n{"a":2}');
  });

  it('refuses empty input before calling Shopify', async () => {
    const scripted: ScriptedClient = scriptedClient({});
    expect(
      failureOf(await stageBulkMutationInput(scripted.client, [])).message
    ).toContain('empty');
    expect(
      failureOf(await stageBulkMutationInput(scripted.client, '  \n')).message
    ).toContain('empty');
    expect(scripted.calls).toEqual([]);
  });

  it('reports staged-upload problems', async () => {
    const withErrors: ScriptedClient = scriptedClient({
      StagedUploadsCreate: started({
        stagedUploadsCreate: {
          stagedTargets: null,
          userErrors: [{ field: ['input'], message: 'bad' }],
        },
      }),
    });
    expect(
      failureOf(
        await stageBulkMutationInput(withErrors.client, '{"a":1}', {
          fetch: uploadMock(),
        })
      )
    ).toBeInstanceOf(UserError);
    const noTarget: ScriptedClient = scriptedClient({
      StagedUploadsCreate: started({
        stagedUploadsCreate: { stagedTargets: [], userErrors: [] },
      }),
    });
    expect(
      failureOf(
        await stageBulkMutationInput(noTarget.client, '{"a":1}', {
          fetch: uploadMock(),
        })
      ).message
    ).toContain('no https upload URL');
    const insecure: ScriptedClient = scriptedClient({
      StagedUploadsCreate: started({
        stagedUploadsCreate: {
          stagedTargets: [{ ...target, url: 'http://evil.example.com/x' }],
          userErrors: [],
        },
      }),
    });
    expect(
      failureOf(
        await stageBulkMutationInput(insecure.client, '{"a":1}', {
          fetch: uploadMock(),
        })
      ).message
    ).toContain('https');
    const noKey: ScriptedClient = scriptedClient({
      StagedUploadsCreate: started({
        stagedUploadsCreate: {
          stagedTargets: [{ ...target, parameters: [] }],
          userErrors: [],
        },
      }),
    });
    expect(
      failureOf(
        await stageBulkMutationInput(noKey.client, '{"a":1}', {
          fetch: uploadMock(),
        })
      ).message
    ).toContain('"key"');
    const down: ScriptedClient = scriptedClient({
      StagedUploadsCreate: () => new NetworkError('offline'),
    });
    expect((await stageBulkMutationInput(down.client, '{"a":1}')).ok).toBe(
      false
    );
  });

  it('reports a rejected or failed upload', async () => {
    const scripted: ScriptedClient = scriptedClient({
      StagedUploadsCreate: staged,
    });
    const rejected: ShopifyError = failureOf(
      await stageBulkMutationInput(scripted.client, '{"a":1}', {
        fetch: uploadMock(
          new Response('<Error>Expired</Error>', { status: 403 })
        ),
      })
    );
    expect(rejected.message).toContain('HTTP 403');
    expect(rejected.message).toContain('Expired');
    const failed: ShopifyError = failureOf(
      await stageBulkMutationInput(scripted.client, '{"a":1}', {
        fetch: uploadMock(new TypeError('fetch failed')),
      })
    );
    expect(failed).toBeInstanceOf(NetworkError);
    const brokenBody: Response = new Response('x', { status: 500 });
    vi.spyOn(brokenBody, 'text').mockRejectedValue(new Error('reset'));
    expect(
      failureOf(
        await stageBulkMutationInput(scripted.client, '{"a":1}', {
          fetch: uploadMock(brokenBody),
        })
      ).message
    ).toContain('HTTP 500');
  });

  it('starts a bulk mutation with an optional client identifier', async () => {
    const scripted: ScriptedClient = scriptedClient({
      BulkOperationRunMutation: started({
        bulkOperationRunMutation: {
          bulkOperation: raw({ type: 'MUTATION' }),
          userErrors: [],
        },
      }),
    });
    const withId: Run = await startBulkMutation(
      scripted.client,
      'mutation M($input: X!) { m(input: $input) { id } }',
      stagedPath,
      { clientIdentifier: 'job-7' }
    );
    expect(withId.ok && withId.value.type).toBe('MUTATION');
    expect(scripted.calls[0]?.variables).toMatchObject({
      stagedUploadPath: stagedPath,
      clientIdentifier: 'job-7',
    });
    await startBulkMutation(scripted.client, 'mutation M { m }', stagedPath);
    expect(scripted.calls[1]?.variables).not.toHaveProperty('clientIdentifier');
  });

  it('runs upload, start and wait end to end', async () => {
    const scripted: ScriptedClient = scriptedClient({
      StagedUploadsCreate: staged,
      BulkOperationRunMutation: started({
        bulkOperationRunMutation: {
          bulkOperation: raw({ type: 'MUTATION' }),
          userErrors: [],
        },
      }),
      BulkOperationStatus: started({
        node: raw({
          type: 'MUTATION',
          status: 'COMPLETED',
          url: 'https://x/out.jsonl',
        }),
      }),
    });
    const result: Run = await runBulkMutation(
      scripted.client,
      'mutation M($input: X!) { m(input: $input) { id } }',
      [{ input: {} }],
      { fetch: uploadMock() }
    );
    expect(result.ok && result.value.url).toBe('https://x/out.jsonl');
    expect(scripted.calls.map((call) => call.operation)).toEqual([
      'StagedUploadsCreate',
      'BulkOperationRunMutation',
      'BulkOperationStatus',
    ]);
  });

  it('stops early when the upload or the start fails', async () => {
    const noUpload: ScriptedClient = scriptedClient({
      StagedUploadsCreate: () => new NetworkError('offline'),
    });
    expect(
      (await runBulkMutation(noUpload.client, 'mutation M { m }', '{"a":1}')).ok
    ).toBe(false);
    const noStart: ScriptedClient = scriptedClient({
      StagedUploadsCreate: staged,
      BulkOperationRunMutation: () => new NetworkError('offline'),
    });
    expect(
      (
        await runBulkMutation(noStart.client, 'mutation M { m }', '{"a":1}', {
          fetch: uploadMock(),
        })
      ).ok
    ).toBe(false);
    expect(noStart.calls.map((call) => call.operation)).not.toContain(
      'BulkOperationStatus'
    );
  });
});
