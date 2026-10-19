// Fails the build if the package grows past its size budget, gains a runtime
// dependency, or imports anything that is not available in every runtime.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const budgets = [
  // [label, imported symbols (null = everything), max minified+gzipped bytes]
  ['everything', null, 18_000],
  ['verifyWebhook only', ['verifyWebhook'], 3_000],
  ['validateIdToken only', ['validateIdToken'], 3_000],
  ['streamBulkResults only', ['streamBulkResults'], 2_500],
  ['createAdminClient only', ['createAdminClient'], 6_000],
  ['createStorefrontClient only', ['createStorefrontClient'], 6_500],
];
const rawBudgets = [
  ['dist/index.js', 24_000],
  ['dist/index.cjs', 24_000],
];

let failed = false;
const report = (ok, message) => {
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
};

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
for (const field of [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
]) {
  report(
    manifest[field] === undefined || Object.keys(manifest[field]).length === 0,
    `package.json has no ${field}`
  );
}

for (const [file, max] of rawBudgets) {
  const size = gzipSync(readFileSync(file), { level: 9 }).length;
  report(size <= max, `${file}: ${size} B gzipped (budget ${max})`);
}
report(
  !/\brequire\(|from ["']node:|import\(["']node:/.test(
    readFileSync('dist/index.cjs', 'utf8') +
      readFileSync('dist/index.js', 'utf8')
  ),
  'dist has no require() or node: imports'
);

for (const [label, symbols, max] of budgets) {
  const entry =
    symbols === null
      ? "import * as lib from './dist/index.js'; console.log(lib);"
      : `import { ${symbols.join(', ')} } from './dist/index.js'; console.log(${symbols.join(', ')});`;
  try {
    // platform "neutral" with nothing external: any Node-only import fails to resolve.
    const result = await build({
      stdin: { contents: entry, resolveDir: process.cwd(), loader: 'js' },
      bundle: true,
      minify: true,
      format: 'esm',
      platform: 'neutral',
      write: false,
      logLevel: 'silent',
    });
    const size = gzipSync(result.outputFiles[0].contents, { level: 9 }).length;
    report(size <= max, `${label}: ${size} B minified+gzipped (budget ${max})`);
  } catch (thrown) {
    report(
      false,
      `${label}: does not bundle for a neutral platform: ${thrown.message}`
    );
  }
}
process.exit(failed ? 1 : 0);
