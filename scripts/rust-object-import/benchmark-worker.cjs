const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { repository, persist, Ref } = require('./persistence.cjs');
(async () => {
  const [fixture, directory, mode, executable] = process.argv.slice(2);
  const manifest = JSON.parse(await fs.readFile(path.join(fixture, 'manifest.json'), 'utf8'));
  const repo = await repository(directory);
  async function* incoming() {
    for (const hash of manifest.hashes)
      yield { ref: new Ref(hash), buffer: await fs.readFile(path.join(fixture, hash)) };
  }
  process.env.BIT_RUST_OBJECT_IMPORT = mode === 'control' ? 'control' : 'off';
  const start = performance.now();
  const result = await persist(repo, incoming(), mode === 'native' ? executable : undefined);
  const persistedMs = performance.now() - start;
  console.log(JSON.stringify({ event: 'persisted' }));
  // Include the cost of rehydrating Sources after native writes instead of hiding it.
  for (const hash of manifest.hashes) {
    const loaded = await repo.load(new Ref(hash));
    if (loaded.hash().toString() !== hash) throw new Error('persisted content mismatch');
  }
  console.log(
    JSON.stringify({
      mode,
      persistedMs,
      includingReadsMs: performance.now() - start,
      count: result.hashes.length,
      stats: result.stats,
    })
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
