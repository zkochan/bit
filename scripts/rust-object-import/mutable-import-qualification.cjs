// Compiled importer, canonical merge policy and real repository writes; evidence stays outside Git.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { Readable } = require('node:stream');
const { createHash } = require('node:crypto');
const { benchmarkGlobals } = require('../rust-dependency-analysis/command-workspace.cjs');
(async () => {
  const cli = path.resolve(process.argv[2]);
  const helper = path.resolve(process.argv[3]);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-mutable-import-'));
  process.env.BIT_GLOBALS_DIR = benchmarkGlobals(temporary);
  const provenance = JSON.parse(await fs.readFile(path.join(cli, '.bit-object-import-build.json')));
  for (const file of provenance.compiledModules)
    assert.equal(
      createHash('sha256')
        .update(await fs.readFile(path.join(cli, 'node_modules/@teambit', file.path)))
        .digest('hex'),
      file.sha256
    );
  const load = createRequire(path.join(cli, 'package.json'));
  const { Repository, Ref, Version, VersionHistory, LaneHistory } = load('@teambit/objects');
  const { ObjectFetcher } = load(
    path.join(cli, 'node_modules/@teambit/legacy.scope/dist/objects-fetcher/objects-fetcher.js')
  );
  const { RustObjectImporter } = load(
    path.join(cli, 'node_modules/@teambit/legacy.scope/dist/objects-fetcher/rust-object-importer.js')
  );
  let nativeWrites = 0;
  const persistMetadata = RustObjectImporter.prototype.persistMetadata;
  RustObjectImporter.prototype.persistMetadata = async function (...args) {
    const sizes = await persistMetadata.apply(this, args);
    nativeWrites += sizes?.filter((value) => value !== null).length || 0;
    return sizes;
  };
  const ref = (index) => new Ref(index.toString(16).padStart(40, '0'));
  const report = [];
  async function qualify(mode) {
    process.env.BIT_RUST_OBJECT_IMPORT = mode === 'missing' ? path.join(temporary, 'missing-helper') : helper;
    const repo = await Repository.create({
      scopePath: path.join(temporary, mode),
      scopeJson: { name: 'mutable-test' },
    });
    const history = new VersionHistory({
      name: 'component',
      scope: 'scope',
      versions: [
        { hash: ref(1), parents: [ref(2)] },
        { hash: ref(2), parents: [] },
      ],
      graphCompleteRefs: [ref(2).toString()],
    });
    const incomingHistory = new VersionHistory({
      name: 'component',
      scope: 'scope',
      versions: [
        { hash: ref(3), parents: [ref(2)] },
        { hash: ref(1), parents: [ref(3)], unrelated: ref(4), squashed: [ref(5)] },
      ],
      graphCompleteRefs: [ref(3).toString()],
    });
    const lane = LaneHistory.parse(
      JSON.stringify({
        name: 'lane',
        scope: 'local',
        laneHash: ref(10).toString(),
        history: {
          local: { log: { date: '1' }, components: ['scope/local@1'] },
          duplicate: { log: { date: '2' }, components: ['scope/old@1'], updateDependents: ['scope/hidden@1'] },
        },
      })
    );
    const incomingLane = LaneHistory.parse(
      JSON.stringify({
        name: 'lane',
        scope: 'remote',
        laneHash: ref(10).toString(),
        history: {
          duplicate: { log: { date: '3' }, components: [], deleted: ['scope/old@1'], updateDependents: [] },
          remote: { log: { date: '4' }, components: ['scope/remote@1'] },
        },
      })
    );
    const version = new Version({
      mainFile: 'index.js',
      files: [{ name: 'index.js', relativePath: 'index.js', test: false, file: ref(20) }],
      log: { message: 'local', date: '100', username: 'test', email: 'test@example.invalid' },
      parents: [],
    });
    version._hash = version.calculateHash().toString();
    const incomingVersion = Version.parse(version.toBuffer().toString(), version.hash().toString());
    incomingVersion.modified = [{ date: '200', message: 'incoming' }];
    const expectedHistory = VersionHistory.parse(history.toBuffer().toString());
    expectedHistory.merge(incomingHistory);
    const expectedLane = LaneHistory.parse(lane.toBuffer().toString());
    expectedLane.merge(incomingLane);
    await repo.writeObjectsToTheFS([history, lane, version]);
    for (const object of [history, lane, version]) repo.setCache(object);
    let canonicalWrites = 0;
    if (mode === 'override') {
      const write = repo.writeObjectsToTheFS.bind(repo);
      repo.writeObjectsToTheFS = async (...args) => {
        canonicalWrites++;
        return write(...args);
      };
    }
    if (mode === 'transform') {
      repo.onPersist = (buffer) => {
        canonicalWrites++;
        return buffer;
      };
    }
    if (mode === 'index-override') {
      const addMany = repo.scopeIndex.addMany.bind(repo.scopeIndex);
      repo.scopeIndex.addMany = (...args) => {
        canonicalWrites++;
        return addMany(...args);
      };
    }
    async function fetch(objects) {
      const items = await Promise.all(
        objects.map(async (object) => ({ ref: object.hash(), buffer: await object.compress() }))
      );
      const fetcher = new ObjectFetcher(
        repo,
        { sources: {} },
        { resolve: async () => ({ fetch: async () => Readable.from(items) }) },
        {},
        [],
        undefined,
        undefined,
        true,
        { remote: items.map((item) => item.ref.toString()) }
      );
      await fetcher.fetchFromRemoteAndWrite();
    }
    const before = nativeWrites;
    await fetch([incomingHistory, incomingLane, incomingVersion]);
    assert.equal(nativeWrites - before, mode === 'native' ? 3 : 0);
    assert.deepEqual(history.toObject(), expectedHistory.toObject());
    assert.deepEqual(lane.toObject(), expectedLane.toObject());
    assert.equal(repo.getCache(history.hash()), history, 'history merge keeps its hydrated instance');
    assert.equal(repo.getCache(lane.hash()), lane, 'lane history merge keeps its hydrated instance');
    assert.deepEqual(repo.getCache(version.hash()).toObject(), incomingVersion.toObject());
    const cachedVersion = repo.getCache(version.hash());
    await fetch([version]);
    assert.equal(
      repo.getCache(version.hash()),
      cachedVersion,
      'an older incoming Version must not replace a newer local one'
    );
    const oversized = LaneHistory.parse(
      JSON.stringify({
        name: 'large-lane',
        scope: 'scope',
        laneHash: ref(11).toString(),
        history: {
          entry: { log: { date: '5', message: 'a'.repeat(600 * 1024) }, components: [], updateDependents: [] },
        },
      })
    );
    await fetch([oversized]);
    repo.removeFromCache(oversized.hash());
    assert.deepEqual(
      (await repo.load(oversized.hash())).toObject(),
      oversized.toObject(),
      'oversized metadata stays on the canonical path'
    );
    for (const [object, expected] of [
      [history, expectedHistory],
      [lane, expectedLane],
      [version, incomingVersion],
    ]) {
      repo.removeFromCache(object.hash());
      assert.deepEqual(
        (await repo.load(object.hash())).toObject(),
        expected.toObject(),
        'cold disk readback must match canonical merge'
      );
    }
    assert.deepEqual(repo.scopeIndex.index.components, []);
    assert.deepEqual(repo.scopeIndex.index.lanes, []);
    if (mode === 'override' || mode === 'transform' || mode === 'index-override') assert.equal(canonicalWrites, 4);
    report.push({
      mode,
      nativeWrites: nativeWrites - before,
      cacheIdentity: true,
      coldReadback: true,
      newerVersionPolicy: true,
    });
  }
  for (const mode of ['native', 'missing', 'override', 'transform', 'index-override']) await qualify(mode);
  const errors = [];
  for (const mode of ['off', 'native']) {
    process.env.BIT_RUST_OBJECT_IMPORT = mode === 'native' ? helper : 'off';
    const repo = await Repository.create({
      scopePath: path.join(temporary, `failure-${mode}`),
      scopeJson: { name: 'mutable-test' },
    });
    const object = VersionHistory.create('blocked', 'scope', []);
    await fs.mkdir(repo.objectPath(object.hash()), { recursive: true });
    const item = { ref: object.hash(), buffer: await object.compress() };
    const fetcher = new ObjectFetcher(
      repo,
      { sources: {} },
      { resolve: async () => ({ fetch: async () => Readable.from([item]) }) },
      {},
      [],
      undefined,
      undefined,
      true,
      { remote: [item.ref.toString()] }
    );
    await assert.rejects(fetcher.fetchFromRemoteAndWrite(), (error) => {
      errors.push({ name: error.name, code: error.code });
      return Boolean(error.code);
    });
    assert.equal((await fs.stat(repo.objectPath(object.hash()))).isDirectory(), true);
  }
  assert.deepEqual(errors[0], errors[1], 'native write failure must preserve canonical error kind');
  report.push({ writeErrorParity: errors[0] });
  console.log(JSON.stringify(report));
  await fs.rm(temporary, { recursive: true, force: true });
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
