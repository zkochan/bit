// Compiled mutable writer and old/current history algorithms; generated evidence stays outside Git.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { createHook } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const cli = path.resolve(process.argv[2]);
const helper = path.resolve(process.argv[3]);
const report = path.resolve(process.argv[4]);
const repository = path.resolve(__dirname, '../..');
const scratchDirectory = path.resolve(process.env.BIT_MUTABLE_TMPDIR || os.tmpdir());
assert.ok(process.argv[4] && report !== repository && !report.startsWith(repository + path.sep));
assert.ok(scratchDirectory !== repository && !scratchDirectory.startsWith(repository + path.sep));
const load = createRequire(path.join(cli, 'package.json'));
const { Repository, Ref, VersionHistory } = load('@teambit/objects');
const { difference } = load('lodash');
const { ObjectsWritable } = load(
  path.join(cli, 'node_modules/@teambit/legacy.scope/dist/objects-fetcher/objects-writable-stream.js')
);
const { WriteObjectsQueue } = load(
  path.join(cli, 'node_modules/@teambit/legacy.scope/dist/objects-fetcher/write-objects-queue.js')
);
const { RustObjectImporter } = load(
  path.join(cli, 'node_modules/@teambit/legacy.scope/dist/objects-fetcher/rust-object-importer.js')
);
const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const ref = (index) => new Ref(index.toString(16).padStart(40, '0'));
(async () => {
  const scratch = await fs.mkdtemp(path.join(scratchDirectory, 'bit-mutable-bench-'));
  const provenance = JSON.parse(await fs.readFile(path.join(cli, '.bit-object-import-build.json')));
  for (const file of provenance.compiledModules)
    assert.equal(
      createHash('sha256')
        .update(await fs.readFile(path.join(cli, 'node_modules/@teambit', file.path)))
        .digest('hex'),
      file.sha256
    );
  const result = {
    node: process.version,
    rounds: 9,
    cliProvenance: provenance,
    helperSha256: createHash('sha256')
      .update(await fs.readFile(helper))
      .digest('hex'),
    writes: [],
    merges: [],
  };
  for (const count of [4096, 16384]) {
    const existing = Array.from({ length: count }, (_, index) => ({
      hash: ref(index),
      parents: index ? [ref(index - 1)] : [],
    }));
    const incoming = Array.from({ length: count }, (_, index) => ({ hash: ref(index + count / 2), parents: [] }));
    const remote = VersionHistory.create('component', 'scope', incoming);
    const timings = { previous: [], linear: [] };
    for (let round = -1; round < 9; round++) {
      for (const mode of round % 2 ? ['linear', 'previous'] : ['previous', 'linear']) {
        const local = VersionHistory.create('component', 'scope', existing);
        const start = performance.now();
        if (mode === 'linear') local.merge(remote);
        else {
          const hashes = difference(local.getAllHashesAsString(), remote.getAllHashesAsString());
          const retained = local.versions.filter((v) => hashes.includes(v.hash.toString()));
          local.versionsObj = local.versionParentsToObject([...remote.versions, ...retained]);
        }
        const elapsed = performance.now() - start;
        assert.deepEqual(local.versions, [...incoming, ...existing.slice(0, count / 2)]);
        if (round >= 0) timings[mode].push(elapsed);
      }
    }
    result.merges.push({
      count,
      timings,
      mediansMs: Object.fromEntries(Object.entries(timings).map(([mode, values]) => [mode, median(values)])),
    });
  }
  for (const entries of [8, 128, 512]) {
    const objects = Array.from({ length: 256 }, (_, index) =>
      VersionHistory.create(
        `component-${index}`,
        'scope',
        Array.from({ length: entries }, (_, version) => ({
          hash: ref(version),
          parents: version ? [ref(version - 1)] : [],
        }))
      )
    );
    const timings = { node: [], native: [] };
    const callbacks = {};
    async function run(mode, diagnostic = false) {
      const directory = await fs.mkdtemp(path.join(scratch, 'scope-'));
      const repo = await Repository.create({ scopePath: directory, scopeJson: { name: 'mutable-bench' } });
      await repo.writeObjectsToTheFS(objects);
      const options = await repo.getNativeSourceStoreOptions();
      const writer = mode === 'native' ? new RustObjectImporter(helper, options) : undefined;
      const writable = new ObjectsWritable(repo, 'remote', new WriteObjectsQueue(), {}, undefined, undefined, writer);
      let filesystem = 0,
        compression = 0;
      const hook = createHook({
        init(_, type) {
          if (type.startsWith('FSREQ')) filesystem++;
          if (type === 'ZLIB') compression++;
        },
      });
      if (diagnostic) hook.enable();
      const start = performance.now();
      for (const object of objects) await writable.writeMutableObject(object);
      await writer?.disposeAndWait();
      const elapsed = performance.now() - start;
      hook.disable();
      writable.destroy();
      if (writer)
        assert.equal(writer.stats.mutablePersisted, objects[0].serialize().byteLength > 16 * 1024 ? 0 : objects.length);
      for (const object of objects) {
        repo.removeFromCache(object.hash());
        assert.deepEqual((await repo.load(object.hash())).toObject(), object.toObject());
      }
      await fs.rm(directory, { recursive: true, force: true });
      if (diagnostic) callbacks[mode] = { filesystem, compression };
      return elapsed;
    }
    for (let round = -1; round < 9; round++) {
      for (const mode of round % 2 ? ['native', 'node'] : ['node', 'native']) {
        global.gc?.();
        const elapsed = await run(mode);
        if (round >= 0) timings[mode].push(elapsed);
      }
    }
    for (const mode of ['node', 'native']) await run(mode, true);
    result.writes.push({
      entries,
      objects: objects.length,
      timings,
      callbacks,
      mediansMs: Object.fromEntries(Object.entries(timings).map(([mode, values]) => [mode, median(values)])),
    });
  }
  await fs.writeFile(report, JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      merges: result.merges.map(({ count, mediansMs }) => ({ count, mediansMs })),
      writes: result.writes.map(({ entries, mediansMs, callbacks }) => ({ entries, mediansMs, callbacks })),
    })
  );
  await fs.rm(scratch, { recursive: true, force: true });
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
