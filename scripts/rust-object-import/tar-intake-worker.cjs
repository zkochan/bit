// Disposable worker: probe the real compiled decoder or benchmark the existing native batch path.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { createRequire } = require('node:module');
const { performance } = require('node:perf_hooks');
const { pipeline } = require('node:stream/promises');
const [cli, mode, archive, executable, directory] = process.argv.slice(2);
const load = createRequire(path.join(cli, 'package.json'));
const { ObjectList } = load('@teambit/objects');
const { RustObjectImporter } = require('./load-source.cjs').source(
  'components/legacy/scope/objects-fetcher/rust-object-importer.ts'
);
let completed = false;
let input;
let importer;
const observed = [];
function finish(result) {
  if (completed) return;
  completed = true;
  input?.destroy();
  importer?.dispose();
  process.stdout.write(JSON.stringify(result) + '\n');
}
process.on('uncaughtException', (error) => finish({ error: error.message, entries: observed }));
(async () => {
  const started = performance.now();
  if (mode === 'native' && executable.endsWith('.cjs')) {
    const result = await require(executable).processArchive(archive, 'store', directory);
    finish({ ...result, elapsedMs: performance.now() - started });
    return;
  }
  input = fs.createReadStream(archive);
  if (mode === 'native') {
    const child = cp.spawn(executable, ['store', directory], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const closed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    await pipeline(input, child.stdin).catch((error) => {
      if (error.code !== 'EPIPE') throw error;
    });
    const code = await closed;
    if (code) throw new Error(stderr.trim());
    finish({ ...JSON.parse(stdout), elapsedMs: performance.now() - started });
    return;
  }
  const entries = observed;
  let count = 0;
  let sources = 0;
  if (mode === 'control') importer = new RustObjectImporter(executable, { objectsDirectory: directory });
  let batch = [];
  async function flush() {
    if (!batch.length) return;
    await importer.importBatch(
      batch,
      async (values) => {
        const selected = values.flatMap((value, index) => (value && !('metadata' in value) ? [index] : []));
        sources += selected.length;
        return selected;
      },
      async (selected, persisted) => {
        if (persisted?.size !== selected.length) throw new Error('benchmark persistence fallback');
      }
    );
    batch = [];
  }
  const stream = ObjectList.fromTarToObjectStream(input);
  if (mode === 'probe') {
    await new Promise((resolve, reject) => {
      stream.on('data', (object) =>
        entries.push({
          name: ObjectList.combineScopeAndHash(object),
          size: object.buffer.length,
          sha1: crypto.createHash('sha1').update(object.buffer).digest('hex'),
        })
      );
      stream.once('error', reject);
      stream.once('end', resolve);
    });
    finish({ entries, count: entries.length, elapsedMs: performance.now() - started });
    return;
  }
  for await (const object of stream) {
    count++;
    if (mode === 'control') {
      batch.push(object);
      if (batch.length === 16) await flush();
    }
  }
  if (importer) {
    await flush();
    await importer.disposeAndWait();
  }
  finish({ entries, count, sources, elapsedMs: performance.now() - started });
})().catch((error) => finish({ error: error.message, entries: observed }));
