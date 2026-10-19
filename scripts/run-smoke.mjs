// Usage: <runtime> scripts/run-smoke.mjs [esm|cjs]  (after `npm run build`)
import { report, smoke } from './runtime-smoke.mjs';

const flavor =
  typeof process !== 'undefined' ? (process.argv[2] ?? 'esm') : 'esm';
const label =
  typeof Deno !== 'undefined'
    ? `deno ${Deno.version.deno}`
    : typeof Bun !== 'undefined'
      ? `bun ${Bun.version}`
      : `node ${process.version}`;

let lib;
if (flavor === 'cjs') {
  const { createRequire } = await import('node:module');
  lib = createRequire(import.meta.url)('../dist/index.cjs');
} else {
  lib = await import('../dist/index.js');
}
const code = report(`${label} ${flavor}`, await smoke(lib));
if (typeof Deno !== 'undefined') Deno.exit(code);
else process.exit(code);
