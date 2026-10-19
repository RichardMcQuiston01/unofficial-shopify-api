import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  collectBulkResults,
  streamBulkResults,
  type BulkRow,
  type Result,
} from '../src/index.js';

const signedUrl: string =
  'https://storage.example.com/results.jsonl?signature=SECRET123';

/** A response whose body arrives in the given byte chunks. */
function chunked(
  chunks: readonly Uint8Array[],
  status: number = 200
): Response {
  let index: number = 0;
  const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
    pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
      const chunk: Uint8Array | undefined = chunks[index++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
  });
  return new Response(body, { status });
}

function fetchReturning(response: Response | Error): Mock<typeof fetch> {
  return vi.fn<typeof fetch>(() =>
    response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response)
  );
}

async function drain(
  url: string | null,
  fetchMock?: Mock<typeof fetch>
): Promise<Result<BulkRow>[]> {
  const rows: Result<BulkRow>[] = [];
  for await (const row of streamBulkResults(
    url,
    fetchMock === undefined ? {} : { fetch: fetchMock }
  )) {
    rows.push(row);
  }
  return rows;
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('streamBulkResults', () => {
  it('yields one row per line, including rows split across chunks', async () => {
    const text: string =
      '{"id":"1"}\n{"id":"2","__parentId":"1"}\r\n\n{"id":"3"}';
    const chunks: Uint8Array[] = [
      encode(text.slice(0, 7)),
      encode(text.slice(7, 25)),
      encode(text.slice(25)),
    ];
    const rows: Result<BulkRow>[] = await drain(
      signedUrl,
      fetchReturning(chunked(chunks))
    );
    expect(rows).toEqual([
      { ok: true, value: { id: '1' } },
      { ok: true, value: { id: '2', __parentId: '1' } },
      { ok: true, value: { id: '3' } },
    ]);
  });

  it('decodes multi-byte characters split across chunks', async () => {
    const bytes: Uint8Array = encode('{"title":"Ünïcode ✓"}\n');
    const rows: Result<BulkRow>[] = await drain(
      signedUrl,
      fetchReturning(chunked([bytes.slice(0, 10), bytes.slice(10)]))
    );
    expect(rows).toEqual([{ ok: true, value: { title: 'Ünïcode ✓' } }]);
  });

  it('yields nothing when there are no results', async () => {
    expect(await drain(null)).toEqual([]);
    expect(await drain(signedUrl, fetchReturning(new Response('')))).toEqual(
      []
    );
  });

  it('works when the response has no stream body', async () => {
    const response: Response = new Response('{"id":"1"}\n{"id":"2"}\n');
    Object.defineProperty(response, 'body', { value: null });
    expect(
      (await drain(signedUrl, fetchReturning(response))).map((row) => row.ok)
    ).toEqual([true, true]);
  });

  it('downloads without credentials or custom headers', async () => {
    const fetchMock: Mock<typeof fetch> = fetchReturning(
      new Response('{"id":"1"}\n')
    );
    await drain(signedUrl, fetchMock);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(signedUrl);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toBeUndefined();
  });

  it('stops at the first invalid line and reports its number', async () => {
    const rows: Result<BulkRow>[] = await drain(
      signedUrl,
      fetchReturning(chunked([encode('{"id":"1"}\n{oops}\n{"id":"3"}\n')]))
    );
    expect(rows).toHaveLength(2);
    expect(!rows[1]?.ok && rows[1]?.error.message).toContain('line 2');
    const trailing: Result<BulkRow>[] = await drain(
      signedUrl,
      fetchReturning(new Response('{"id":"1"}\nbroken'))
    );
    expect(trailing.at(-1)?.ok).toBe(false);
  });

  it('reports failed downloads without leaking the signed URL', async () => {
    const expired: Result<BulkRow>[] = await drain(
      signedUrl,
      fetchReturning(new Response('', { status: 403 }))
    );
    expect(!expired[0]?.ok && expired[0]?.error.message).toContain('HTTP 403');
    expect(!expired[0]?.ok && expired[0]?.error.message).not.toContain(
      'SECRET123'
    );
    const offline: Result<BulkRow>[] = await drain(
      signedUrl,
      fetchReturning(new TypeError('fetch failed'))
    );
    expect(!offline[0]?.ok && offline[0]?.error.message).toContain(
      'fetch failed'
    );
    expect(!offline[0]?.ok && offline[0]?.error.message).not.toContain(
      'SECRET123'
    );
  });

  it('reports a body that fails midway', async () => {
    const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
      start(controller: ReadableStreamDefaultController<Uint8Array>): void {
        controller.enqueue(encode('{"id":"1"}\n'));
      },
      pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
        controller.error(new Error('connection reset'));
      },
    });
    const rows: Result<BulkRow>[] = await drain(
      signedUrl,
      fetchReturning(new Response(body))
    );
    expect(rows[0]?.ok).toBe(true);
    expect(!rows[1]?.ok && rows[1]?.error.message).toContain(
      'connection reset'
    );
  });

  it('refuses a non-https URL', async () => {
    const rows: Result<BulkRow>[] = await drain(
      'http://storage.example.com/r.jsonl?sig=SECRET123'
    );
    expect(!rows[0]?.ok && rows[0]?.error.message).toContain('https');
    expect(!rows[0]?.ok && rows[0]?.error.message).not.toContain('SECRET123');
  });

  it('can be cut short by the consumer', async () => {
    const fetchMock: Mock<typeof fetch> = fetchReturning(
      chunked([
        encode('{"id":"1"}\n'),
        encode('{"id":"2"}\n'),
        encode('{"id":"3"}\n'),
      ])
    );
    for await (const row of streamBulkResults(signedUrl, {
      fetch: fetchMock,
    })) {
      expect(row.ok).toBe(true);
      break;
    }
  });

  it('passes an abort signal to fetch', async () => {
    const controller: AbortController = new AbortController();
    const fetchMock: Mock<typeof fetch> = fetchReturning(new Response(''));
    await streamBulkResults(signedUrl, {
      fetch: fetchMock,
      signal: controller.signal,
    }).next();
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });
});

describe('collectBulkResults', () => {
  it('collects all rows and honors maxRows', async () => {
    const text: string = '{"id":"1"}\n{"id":"2"}\n{"id":"3"}\n';
    const all: Result<BulkRow[]> = await collectBulkResults(signedUrl, {
      fetch: fetchReturning(new Response(text)),
    });
    expect(all.ok && all.value).toHaveLength(3);
    const capped: Result<BulkRow[]> = await collectBulkResults(signedUrl, {
      fetch: fetchReturning(new Response(text)),
      maxRows: 2,
    });
    expect(!capped.ok && capped.error.message).toContain('maxRows (2)');
    const failed: Result<BulkRow[]> = await collectBulkResults(signedUrl, {
      fetch: fetchReturning(new Response('', { status: 500 })),
    });
    expect(failed.ok).toBe(false);
  });
});
