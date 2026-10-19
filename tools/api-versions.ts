/**
 * Keeps `api-versions.json` in step with Shopify's quarterly Admin and
 * Storefront API releases (01, 04, 07 and 10, each published on the 1st).
 *
 *   npx tsx tools/api-versions.ts check   # exit 1 when the file is stale
 *   npx tsx tools/api-versions.ts write   # rewrite the file for today
 *
 * Shopify supports a stable version for 12 months, so the window is the
 * current version and the three before it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface ApiVersionWindow {
  readonly latest: string;
  readonly supported: readonly string[];
}

const quarterMonths: readonly number[] = [1, 4, 7, 10];
const windowSize: number = 4;
const versionsPath: string = new URL('../api-versions.json', import.meta.url)
  .pathname;

function formatVersion(year: number, month: number): string {
  return `${String(year)}-${String(month).padStart(2, '0')}`;
}

/** The newest stable version Shopify has released on or before `now` (UTC). */
export function latestStableVersion(now: Date): string {
  const year: number = now.getUTCFullYear();
  const month: number = now.getUTCMonth() + 1;
  const quarter: number =
    [...quarterMonths].reverse().find((m: number): boolean => m <= month) ?? 10;
  return formatVersion(year, quarter);
}

/** `count` quarterly versions ending at `latest`, newest first. */
export function supportedWindow(
  latest: string,
  count: number = windowSize
): readonly string[] {
  const [yearText, monthText] = latest.split('-');
  let year: number = Number(yearText);
  let index: number = quarterMonths.indexOf(Number(monthText));
  if (!Number.isInteger(year) || index === -1) {
    throw new Error(
      `Cannot build a version window from "${latest}": expected YYYY-01, YYYY-04, YYYY-07 or YYYY-10.`
    );
  }
  const versions: string[] = [];
  for (let step: number = 0; step < count; step += 1) {
    versions.push(formatVersion(year, quarterMonths[index] ?? 1));
    index -= 1;
    if (index < 0) {
      index = quarterMonths.length - 1;
      year -= 1;
    }
  }
  return versions;
}

export function windowFor(now: Date): ApiVersionWindow {
  const latest: string = latestStableVersion(now);
  return { latest, supported: supportedWindow(latest) };
}

export function serialize(window: ApiVersionWindow): string {
  return `${JSON.stringify(window, null, 2)}\n`;
}

function main(command: string | undefined): number {
  const expected: string = serialize(windowFor(new Date()));
  if (command === 'write') {
    writeFileSync(versionsPath, expected);
    console.log(`Wrote ${versionsPath}`);
    return 0;
  }
  if (command === 'check') {
    const current: string = readFileSync(versionsPath, 'utf8');
    if (current === expected) return 0;
    console.error(
      'api-versions.json is out of date; run `npx tsx tools/api-versions.ts write`.'
    );
    return 1;
  }
  console.error('Usage: tsx tools/api-versions.ts <check|write>');
  return 2;
}

const entry: string | undefined = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = main(process.argv[2]);
}
