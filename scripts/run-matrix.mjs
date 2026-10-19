// Runs the runtime smoke checks against the built package in every runtime that
// is installed. `--strict` turns a missing runtime into a failure (used in CI).
//
//   npm run build
//   npm install --no-save bun deno @edge-runtime/vm workerd   # optional runtimes
//   node scripts/run-matrix.mjs [--strict]
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const strict = process.argv.includes('--strict');
const outcomes = [];

function findBinary(name) {
  const local = join(root, 'node_modules', '.bin', name);
  if (existsSync(local)) return local;
  const found = spawnSync('which', [name], { encoding: 'utf8' });
  return found.status === 0 ? found.stdout.trim() : undefined;
}

function runChild(label, command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  outcomes.push({ label, status: result.status === 0 ? 'pass' : 'FAIL' });
}

function skip(label, hint) {
  console.log(`SKIP  ${label}: not installed (${hint})`);
  outcomes.push({ label, status: 'skipped' });
}

function printResults(label, results) {
  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed += 1;
    console.log(
      `${r.ok ? 'PASS' : 'FAIL'}  [${label}] ${r.name}${r.ok ? '' : ` -- ${r.detail}`}`
    );
  }
  console.log(`${label}: ${results.length - failed}/${results.length} passed`);
  outcomes.push({ label, status: failed === 0 ? 'pass' : 'FAIL' });
}

if (!existsSync(join(root, 'dist', 'index.js'))) {
  console.error('dist/ is missing; run `npm run build` first.');
  process.exit(1);
}

// Node: both module formats.
runChild('node esm', process.execPath, ['scripts/run-smoke.mjs', 'esm']);
runChild('node cjs', process.execPath, ['scripts/run-smoke.mjs', 'cjs']);

// Bun and Deno: ESM.
const bun = findBinary('bun');
if (bun) runChild('bun', bun, ['scripts/run-smoke.mjs', 'esm']);
else skip('bun', 'npm i --no-save bun');
const deno = findBinary('deno');
if (deno)
  runChild('deno', deno, [
    'run',
    '--allow-read',
    'scripts/run-smoke.mjs',
    'esm',
  ]);
else skip('deno', 'npm i --no-save deno');

// Edge runtime VM: the CJS build, with no Node globals (no process, no Buffer).
try {
  const { EdgeVM } = await import(
    pathToFileURL(
      join(root, 'node_modules', '@edge-runtime', 'vm', 'dist', 'index.js')
    ).href
  );
  const cjs = readFileSync(join(root, 'dist', 'index.cjs'), 'utf8');
  const smoke = readFileSync(join(root, 'scripts', 'runtime-smoke.mjs'), 'utf8')
    .replace('export async function smoke', 'async function smoke')
    .replace('export function report', 'function report');
  const vm = new EdgeVM();
  const raw = await vm.evaluate(`(async () => {
    const module = { exports: {} };
    (function (module, exports) {
${cjs}
    })(module, module.exports);
    ${smoke}
    return JSON.stringify({ out: await smoke(module.exports), node: typeof process !== 'undefined' || typeof Buffer !== 'undefined' });
  })()`);
  const { out, node } = JSON.parse(raw);
  if (node)
    throw new Error(
      'the edge VM unexpectedly exposes Node globals, so it proves nothing'
    );
  printResults('edge-runtime vm (no Node globals)', out);
} catch (thrown) {
  if (thrown?.code === 'ERR_MODULE_NOT_FOUND')
    skip('edge-runtime vm', 'npm i --no-save @edge-runtime/vm');
  else {
    console.log(`FAIL  [edge-runtime vm] ${thrown.message}`);
    outcomes.push({ label: 'edge-runtime vm', status: 'FAIL' });
  }
}

// Cloudflare's workerd, without the nodejs_compat flag.
const workerd = findBinary('workerd');
if (!workerd) skip('workerd', 'npm i --no-save workerd');
else {
  const dir = mkdtempSync(join(tmpdir(), 'workerd-smoke-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  try {
    cpSync(join(root, 'dist', 'index.js'), join(dir, 'lib.mjs'));
    cpSync(join(root, 'scripts', 'runtime-smoke.mjs'), join(dir, 'smoke.mjs'));
    writeFileSync(
      join(dir, 'worker.mjs'),
      `import * as lib from './lib.mjs';
import { smoke } from './smoke.mjs';
export default {
  async fetch() {
    const out = await smoke(lib);
    return Response.json({ out, node: typeof process !== 'undefined' || typeof Buffer !== 'undefined' });
  },
};`
    );
    writeFileSync(
      join(dir, 'config.capnp'),
      `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [ (name = "main", worker = .mainWorker) ],
  sockets = [ (name = "http", address = "127.0.0.1:${port}", http = (), service = "main") ]
);
const mainWorker :Workerd.Worker = (
  modules = [
    (name = "worker", esModule = embed "worker.mjs"),
    (name = "lib.mjs", esModule = embed "lib.mjs"),
    (name = "smoke.mjs", esModule = embed "smoke.mjs"),
  ],
  compatibilityDate = "2025-01-01",
);
`
    );
    const child = spawn(workerd, ['serve', 'config.capnp'], {
      cwd: dir,
      stdio: 'ignore',
    });
    let body;
    for (let attempt = 0; attempt < 40 && body === undefined; attempt++) {
      await new Promise((done) => setTimeout(done, 250));
      try {
        body = await (await fetch(`http://127.0.0.1:${port}/`)).json();
      } catch {
        /* not listening yet */
      }
    }
    child.kill();
    if (body === undefined) throw new Error('workerd did not answer');
    if (body.node) throw new Error('workerd unexpectedly exposes Node globals');
    printResults('workerd (no nodejs_compat)', body.out);
  } catch (thrown) {
    console.log(`FAIL  [workerd] ${thrown.message}`);
    outcomes.push({ label: 'workerd', status: 'FAIL' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\nRuntime matrix');
for (const { label, status } of outcomes)
  console.log(`  ${status.padEnd(7)} ${label}`);
const failed = outcomes.some(
  (o) => o.status === 'FAIL' || (strict && o.status === 'skipped')
);
process.exit(failed ? 1 : 0);
