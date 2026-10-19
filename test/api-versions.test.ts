import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { validateApiVersion } from '../src/index.js';
import {
  latestStableVersion,
  serialize,
  supportedWindow,
  windowFor,
  type ApiVersionWindow,
} from '../tools/api-versions.js';

describe('latestStableVersion', () => {
  it.each([
    ['2026-01-01T00:00:00Z', '2026-01'],
    ['2026-03-31T23:59:59Z', '2026-01'],
    ['2026-04-01T00:00:00Z', '2026-04'],
    ['2026-09-30T12:00:00Z', '2026-07'],
    ['2026-10-19T12:00:00Z', '2026-10'],
    ['2026-12-31T23:59:59Z', '2026-10'],
  ])('%s -> %s', (now: string, expected: string) => {
    expect(latestStableVersion(new Date(now))).toBe(expected);
  });
});

describe('supportedWindow', () => {
  it('lists four versions, newest first, across a year boundary', () => {
    expect(supportedWindow('2026-01')).toEqual([
      '2026-01',
      '2025-10',
      '2025-07',
      '2025-04',
    ]);
  });

  it('rejects a version that is not a quarter', () => {
    expect(() => supportedWindow('2026-02')).toThrow('Cannot build');
    expect(() => supportedWindow('unstable')).toThrow('Cannot build');
  });
});

describe('api-versions.json', () => {
  const file: ApiVersionWindow = JSON.parse(
    readFileSync(new URL('../api-versions.json', import.meta.url), 'utf8')
  ) as ApiVersionWindow;

  it('lists only versions the client accepts, newest first', () => {
    for (const version of file.supported) {
      expect(validateApiVersion(version).ok).toBe(true);
    }
    expect(file.supported[0]).toBe(file.latest);
    expect([...file.supported].sort().reverse()).toEqual(file.supported);
  });

  it('is exactly what the tool would write for its own latest version', () => {
    const regenerated: ApiVersionWindow = {
      latest: file.latest,
      supported: supportedWindow(file.latest),
    };
    expect(serialize(regenerated)).toBe(serialize(file));
  });

  it('serializes with a trailing newline', () => {
    expect(serialize(windowFor(new Date('2026-10-19T00:00:00Z')))).toMatch(
      /\n$/
    );
  });
});
