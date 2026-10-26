import {build} from 'esbuild';
import {mkdir, rm, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

// API-only Pages advanced-mode output. No UI, credentials, database export,
// or runtime migration is copied into this folder. Building never deploys.
const output = new URL('../sync-worker/pages/dist/', import.meta.url);
await rm(output, {recursive: true, force: true});
await mkdir(output, {recursive: true});
const result = await build({
  entryPoints: [fileURLToPath(new URL('../sync-worker/src/index.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('_worker.js', output)),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  sourcemap: false,
  legalComments: 'none',
  metafile: true,
  logLevel: 'silent'
});
if (Object.values(result.metafile.outputs).some(item => item.imports.length > 0)) {
  throw new Error('Pages API bundle contains unresolved imports');
}
await writeFile(new URL('_routes.json', output), JSON.stringify({version: 1, include: ['/health', '/v1/*'], exclude: []}, null, 2) + '\n');
console.log('Built sync-worker/pages/dist: _worker.js and _routes.json. No deployment performed.');
