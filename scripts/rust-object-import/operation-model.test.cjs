// Differential coverage uses a physical compiled Bit graph so all instanceof/class identities agree.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { installed } = require('./load-source.cjs');
const { ModelComponent, Ref, NativeImportOperation } = installed('@teambit/objects');
const { ModelComponentMerger } = require(
  path.join(path.dirname(installed.resolve('@teambit/legacy.scope')), 'component-ops/model-components-merger.js')
);
const { DetachedHeads } = require(
  path.join(path.dirname(installed.resolve('@teambit/objects')), 'models/detach-heads.js')
);
const native =
  process.env.BIT_TEST_OBJECT_IMPORT ||
  path.resolve(__dirname, '../../native/target/debug/bit-object-import' + (process.platform === 'win32' ? '.exe' : ''));
function random(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
}
function props(next) {
  const hash = () => next().toString(16).padStart(40, '0');
  const tags = {};
  const orphans = {};
  const state = { versions: {} };
  for (let i = 0; i < 12; i++) {
    const tag = `1.0.${i}`;
    if (next() % 3) tags[tag] = hash();
    if (next() % 3 === 0) orphans[tag] = hash();
    if (next() % 4 === 0) state.versions[tag] = { local: true };
  }
  return {
    tags,
    orphans,
    state,
    head: hash(),
    detached: { heads: [hash(), hash()], deleted: [hash()], current: hash() },
  };
}
function model(value) {
  return new ModelComponent({
    name: 'component',
    scope: 'test.remote',
    versions: Object.fromEntries(Object.entries(value.tags).map(([tag, hash]) => [tag, new Ref(hash)])),
    orphanedVersions: Object.fromEntries(Object.entries(value.orphans).map(([tag, hash]) => [tag, new Ref(hash)])),
    state: structuredClone(value.state),
    head: new Ref(value.head),
    detachedHeads: DetachedHeads.fromObject(value.detached),
  });
}
async function outcome(merger) {
  try {
    const result = await merger.merge();
    return { versions: result.mergedVersions, object: result.mergedComponent.toObject() };
  } catch (error) {
    return {
      error: {
        name: error.constructor.name,
        message: error.message,
        versions: error.versions,
        id: error.id,
        isDeleted: error.isDeleted,
      },
    };
  }
}
test('500 seeded origin/cache component merges match canonical results, errors and live Ref identity', async (t) => {
  assert.ok(NativeImportOperation, 'use the freshly prepared physical CLI');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-component-differential-'));
  const operation = new NativeImportOperation(native, { objectsDirectory: directory });
  t.after(async () => {
    await operation.disposeAndWait();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const next = random(33);
  for (let index = 0; index < 500; index++) {
    const left = props(next),
      right = props(next),
      origin = Boolean(next() % 2);
    // Overlap sometimes agrees and sometimes conflicts; detached refs overlap as well.
    for (const tag of Object.keys(right.tags)) if (left.tags[tag] && next() % 2) right.tags[tag] = left.tags[tag];
    right.detached.heads.push(left.detached.heads[0]);
    right.detached.deleted.push(left.detached.deleted[0]);
    const old = model(left),
      incoming = model(right),
      canonicalOld = model(left),
      canonicalIncoming = model(right);
    const originalRefs = new Set([
      ...Object.values(old.versions),
      ...Object.values(old.orphanedVersions),
      ...Object.values(incoming.versions),
      ...Object.values(incoming.orphanedVersions),
    ]);
    const current = old.detachedHeads.getCurrent();
    const expected = await outcome(new ModelComponentMerger(canonicalOld, canonicalIncoming, true, origin));
    const actual = await outcome(
      new ModelComponentMerger(old, incoming, true, origin, undefined, undefined, operation)
    );
    assert.deepEqual(actual, expected, `case ${index}, origin ${origin}`);
    assert.deepEqual(old.toObject(), canonicalOld.toObject(), 'conflicts also preserve mutation state');
    assert.deepEqual(incoming.toObject(), canonicalIncoming.toObject(), 'incoming remains unchanged');
    assert.equal(old.detachedHeads.getCurrent(), current);
    for (const ref of [...Object.values(old.versions), ...Object.values(old.orphanedVersions)])
      assert.ok(originalRefs.has(ref), 'canonical Ref instances survive');
  }
  assert.equal(operation.stats.operations, 500, 'all ordinary merges actually reached native planning');
});
test('native VersionHistory/LaneHistory plans preserve opaque history fields and shared instances', async (t) => {
  const { VersionHistory, LaneHistory } = installed('@teambit/objects');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-history-differential-'));
  const operation = new NativeImportOperation(native, { objectsDirectory: directory });
  t.after(async () => {
    await operation.disposeAndWait();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const entry = (hash, ordinal) => ({
    hash: new Ref(hash),
    parents: [new Ref('parent-' + ordinal)],
    unrelated: ordinal % 2 ? new Ref('unrelated') : undefined,
    squashed: ordinal % 3 ? undefined : [new Ref('squashed')],
  });
  for (let index = 0; index < 100; index++) {
    const entries = [entry('old', index), entry('shared', index + 1), entry('mutated', index + 2)];
    const incomingEntries = [entry('shared', index + 3), entry('new', index + 4)];
    const props = { name: 'component', scope: 'scope', versions: entries, graphCompleteRefs: ['old'] };
    const canonical = new VersionHistory(props),
      candidate = new VersionHistory(props);
    entries[2].hash.hash = 'changed-after-insertion';
    const incoming = new VersionHistory({ ...props, scope: 'other', versions: incomingEntries });
    canonical.merge(incoming);
    const indices = await operation.request(
      {
        kind: 'versionHistory',
        existing: candidate.versions.map((value) => value.hash.toString()),
        stored: candidate.getAllHashesAsString(),
        incoming: incoming.getAllHashesAsString(),
      },
      (value) => value
    );
    candidate.mergeNative(incoming, indices);
    assert.deepEqual(candidate.toObject(), canonical.toObject());
    assert.equal(candidate.versions[0], incomingEntries[0]);
    assert.equal(candidate.versions.at(-1), entries[0]);
    assert.deepEqual(candidate.graphCompleteRefs, ['old']);
    assert.equal(candidate.hasChanged, false);
    const oldHistory = {
      2: { components: ['a'], log: { date: '9' }, updateDependents: [] },
      first: { components: ['b'], log: { date: '10' } },
      shared: { components: [], log: { date: '11' }, deleted: ['old'] },
    };
    const incomingHistory = {
      shared: { components: ['c'], log: { date: '12' }, deleted: [], updateDependents: ['hidden'] },
      1: { components: [], log: { date: '1' } },
    };
    const laneProps = { name: 'lane', scope: 'scope', laneHash: 'lane-hash', history: oldHistory };
    const oldLane = new LaneHistory(laneProps),
      nativeLane = new LaneHistory(laneProps),
      newLane = new LaneHistory({ ...laneProps, history: incomingHistory });
    oldLane.merge(newLane);
    nativeLane.mergeNative(
      newLane,
      await operation.request(
        { kind: 'laneHistory', existing: Object.keys(oldHistory), incoming: Object.keys(incomingHistory) },
        (value) => value
      )
    );
    assert.deepEqual(nativeLane.toObject(), oldLane.toObject());
    assert.deepEqual(Object.keys(nativeLane.getHistory()), Object.keys(oldLane.getHistory()));
    assert.equal(nativeLane.getHistory().first, oldHistory.first);
    assert.equal(nativeLane.getHistory().shared, incomingHistory.shared);
  }
});
test('real Version dependency/extension fixtures retain canonical hydration, serialization and native persisted bytes', async (t) => {
  const { Version, BitObject } = installed('@teambit/objects');
  const zlib = require('node:zlib');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-version-model-parity-'));
  const operation = new NativeImportOperation(native, { objectsDirectory: directory });
  t.after(async () => {
    await operation.disposeAndWait();
    await fs.rm(directory, { recursive: true, force: true });
  });
  for (const name of ['version-model-object.json', 'version-model-extended.json']) {
    const contents = await fs.readFile(path.resolve(__dirname, '../../scopes/scope/objects/fixtures', name), 'utf8');
    const hash = '3'.repeat(40);
    const version = Version.parse(contents, hash);
    const serialized = version.serialize();
    const result = await operation.request(
      { kind: 'persist', hash, serialized: serialized.toString('hex') },
      (value) => value
    );
    assert.ok(result > 0);
    const compressed = await fs.readFile(path.join(directory, '33', hash.slice(2)));
    assert.deepEqual(zlib.inflateSync(compressed), serialized);
    const hydrated = await BitObject.parseObject(compressed);
    assert.equal(hydrated.constructor, Version);
    assert.deepEqual(hydrated.toObject(), version.toObject());
    assert.deepEqual(hydrated.serialize(), serialized);
  }
  for (const malformed of ['{', '{}', '{"schema":"unknown"}']) {
    let canonical;
    try {
      Version.parse(malformed, '3'.repeat(40)).serialize();
    } catch (error) {
      canonical = error;
    }
    assert.ok(canonical, 'invalid models fail in the canonical constructor before native admission');
  }
});
test('concurrent history mutation invalidates a pending plan and canonical fallback retains all remote entries', async (t) => {
  const { VersionHistory } = installed('@teambit/objects');
  const { ObjectsWritable } = require(
    path.join(path.dirname(installed.resolve('@teambit/legacy.scope')), 'objects-fetcher/objects-writable-stream.js')
  );
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-history-race-'));
  const operation = new NativeImportOperation(native, { objectsDirectory: directory });
  t.after(async () => {
    await operation.disposeAndWait();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const entry = (hash) => ({ hash: new Ref(hash), parents: [] });
  const history = (versions) => new VersionHistory({ name: 'component', scope: 'scope', versions });
  const original = entry('old'),
    first = entry('first'),
    second = entry('second');
  const existing = history([original]),
    incoming = history([first]);
  let submitted, release;
  const ready = new Promise((resolve) => {
    submitted = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const request = operation.request.bind(operation);
  operation.request = async (...args) => {
    submitted();
    await gate;
    return request(...args);
  };
  const writer = new ObjectsWritable(
    { load: async () => existing, getNativeImportOperation: () => operation },
    'remote',
    {},
    {}
  );
  t.after(() => writer.destroy());
  writer.writeMutableObject = async (object) => assert.equal(object, existing);
  const pending = writer.mergeVersionHistory(incoming);
  await ready;
  existing.merge(history([second]));
  release();
  await pending;
  assert.deepEqual(
    existing.versions.map((value) => value.hash.toString()),
    ['first', 'second', 'old']
  );
  assert.ok(
    existing.versions.includes(first) && existing.versions.includes(second) && existing.versions.includes(original)
  );
  assert.equal(operation.stats.stalePlans, 1);
});
test('concurrent index additions invalidate a plan and preserve append positions', async (t) => {
  const { ScopeIndex } = installed('@teambit/objects');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-index-race-'));
  const operation = new NativeImportOperation(native, { objectsDirectory: directory });
  t.after(async () => {
    await operation.disposeAndWait();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const index = ScopeIndex.create(directory);
  const first = new ModelComponent({ name: 'first', scope: 'scope' }),
    second = new ModelComponent({ name: 'second', scope: 'scope' });
  const pending = index.addManyForImport([first], operation);
  index.addMany([second]);
  assert.equal(await pending, true);
  assert.deepEqual(
    index.index.components.map((value) => value.id.name),
    ['second', 'first']
  );
  assert.equal(operation.stats.stalePlans, 1);
});
test('simultaneous coalesced history plans check at application and retain both remote updates', async (t) => {
  const { VersionHistory } = installed('@teambit/objects');
  const { ObjectsWritable } = require(
    path.join(path.dirname(installed.resolve('@teambit/legacy.scope')), 'objects-fetcher/objects-writable-stream.js')
  );
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-coalesced-history-'));
  const operation = new NativeImportOperation(native, { objectsDirectory: directory });
  t.after(async () => {
    await operation.disposeAndWait();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const entry = (hash) => ({ hash: new Ref(hash), parents: [] });
  const history = (hash) => new VersionHistory({ name: 'component', scope: 'scope', versions: [entry(hash)] });
  const existing = history('old');
  const writer = new ObjectsWritable(
    { load: async () => existing, getNativeImportOperation: () => operation },
    'remote',
    {},
    {}
  );
  t.after(() => writer.destroy());
  writer.writeMutableObject = async () => undefined;
  await Promise.all([writer.mergeVersionHistory(history('first')), writer.mergeVersionHistory(history('second'))]);
  assert.deepEqual(
    existing.versions.map((value) => value.hash.toString()),
    ['second', 'first', 'old']
  );
  assert.equal(operation.stats.stalePlans, 1);
  assert.equal(operation.stats.frames, 1);
});
test('write-invalidated missing lookup reuse revalidates external changes and preserves canonical errors', async (t) => {
  const { Repository, Source } = installed('@teambit/objects');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-missing-reuse-'));
  const repo = await Repository.create({ scopePath: directory, scopeJson: { name: 'scope' } });
  const names = ['BIT_RUST_OBJECT_IMPORT', 'BIT_RUST_OBJECT_IMPORT_OPERATION', 'BIT_RUST_OBJECT_IMPORT_MISSING'];
  const previous = names.map((key) => process.env[key]);
  names.forEach((key) => {
    process.env[key] = key === 'BIT_RUST_OBJECT_IMPORT' ? native : 'on';
  });
  if (process.platform === 'win32') {
    names.push('BIT_RUST_OBJECT_IMPORT_WINDOWS_WRITES');
    previous.push(process.env.BIT_RUST_OBJECT_IMPORT_WINDOWS_WRITES);
    process.env.BIT_RUST_OBJECT_IMPORT_WINDOWS_WRITES = 'on';
  }
  t.after(async () => {
    names.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    await fs.rm(directory, { recursive: true, force: true });
  });
  await repo.withNativeImportOperation(async () => {
    const operation = repo.getNativeImportOperation();
    assert.ok(operation);
    const object = Source.from(Buffer.from('externally-created'));
    const ref = object.hash();
    assert.equal(await repo.load(ref), null);
    assert.equal(await repo.load(ref), null);
    assert.equal(operation.stats.missingHits, 1);
    await fs.mkdir(path.dirname(repo.objectPath(ref)), { recursive: true });
    await fs.writeFile(repo.objectPath(ref), await object.compress());
    assert.deepEqual((await repo.load(ref)).contents, object.contents, 'external creation is visible');
    repo.removeFromCache(ref);
    await fs.unlink(repo.objectPath(ref));
    assert.equal(await repo.load(ref), null);
    await repo.writeObjectsToTheFS([object]);
    assert.equal(await repo.load(ref), object, 'own write invalidates negative state and retains live identity');
    const absent = new Ref('8'.repeat(40));
    assert.equal(await repo.load(absent), null);
    await assert.rejects(
      repo.load(absent, true),
      (error) => error.code === 'ENOENT' && error.stack.includes('fatal: failed finding an object file')
    );
    await fs.mkdir(repo.objectPath(absent), { recursive: true });
    await assert.rejects(
      repo.load(absent),
      (error) => error.code === 'EISDIR' || error.code === 'EACCES' || error.code === 'EPERM'
    );
  });
  assert.equal(repo.getNativeImportOperation(), undefined, 'negative state never survives the import session');
});

test('sequential tar metadata preserves accepted prefix before malformed metadata and Source boundaries', async (t) => {
  const { Repository, Version } = installed('@teambit/objects');
  const { ObjectsWritable } = installed('@teambit/legacy.scope/dist/objects-fetcher/objects-writable-stream.js');
  const { WriteObjectsQueue } = installed('@teambit/legacy.scope/dist/objects-fetcher/write-objects-queue.js');
  const { RustObjectImporter } = require(
    path.join(path.dirname(installed.resolve('@teambit/legacy.scope')), 'objects-fetcher/rust-object-importer.js')
  );
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-sequential-prefix-'));
  const repo = await Repository.create({ scopePath: directory, scopeJson: { name: 'scope' } });
  const names = ['BIT_RUST_OBJECT_IMPORT', 'BIT_RUST_OBJECT_IMPORT_OPERATION', 'BIT_RUST_OBJECT_IMPORT_SEQUENTIAL'];
  if (process.platform === 'win32') names.push('BIT_RUST_OBJECT_IMPORT_WINDOWS_WRITES');
  const previous = names.map((key) => process.env[key]);
  names.forEach((key) => {
    process.env[key] = key === 'BIT_RUST_OBJECT_IMPORT' ? native : 'on';
  });
  const queue = new WriteObjectsQueue();
  const mutable = new RustObjectImporter(native, { objectsDirectory: repo.getPath() });
  const writer = new ObjectsWritable(repo, 'remote', queue, {}, undefined, undefined, mutable);
  t.after(async () => {
    writer.destroy();
    await mutable.disposeAndWait();
    names.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    await fs.rm(directory, { recursive: true, force: true });
  });
  const contents = await fs.readFile(
    path.resolve(__dirname, '../../scopes/scope/objects/fixtures/version-model-object.json'),
    'utf8'
  );
  const versions = [1, 2].map((value) => Version.parse(contents, value.toString().repeat(40)));
  const descriptors = versions.map((version) => ({
    name: `scope/${version.hash()}`,
    metadata: { metadata: version.serialize().toString(), inflatedBytes: version.serialize().length },
  }));
  await repo.withNativeImportOperation(async () => {
    const decision = await writer.prepareTarBatch(
      [
        ...descriptors,
        {
          name: `scope/${'3'.repeat(40)}`,
          metadata: { metadata: `Version ${'3'.repeat(40)} 1\0{`, inflatedBytes: 52 },
        },
        { name: `scope/${'4'.repeat(40)}`, sourceHash: '4'.repeat(40) },
      ],
      () => {
        throw new Error('no range reads expected');
      }
    );
    assert.ok(decision.error);
    assert.equal(decision.processed, 2);
    assert.deepEqual(decision.selected, []);
    assert.equal(mutable.stats.mutableBatches, 1);
    for (const version of versions)
      assert.deepEqual((await repo.load(version.hash())).serialize(), version.serialize());
    await assert.rejects(fs.access(repo.objectPath(new Ref('4'.repeat(40)))), { code: 'ENOENT' });
    await decision.settle(new Set());
  });
});

test('arbitrary eight-remote history interleavings preserve every shared entry and live Ref', async (t) => {
  const { VersionHistory } = installed('@teambit/objects');
  const { ObjectsWritable } = installed('@teambit/legacy.scope/dist/objects-fetcher/objects-writable-stream.js');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-interleaved-history-'));
  const operation = new NativeImportOperation(native, { objectsDirectory: directory });
  t.after(async () => {
    await operation.disposeAndWait();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const request = operation.request.bind(operation);
  const next = random(33);
  operation.request = async (...args) => {
    const turns = next() % 4;
    for (let count = 0; count < turns; count++) await new Promise((resolve) => setImmediate(resolve));
    return request(...args);
  };
  for (let round = 0; round < 25; round++) {
    const original = { hash: new Ref(`old-${round}`), parents: [] };
    const entries = Array.from({ length: 8 }, (_, remote) => ({
      hash: new Ref(`${round}-${remote}`),
      parents: [original.hash],
    }));
    const history = (versions) => new VersionHistory({ name: 'component', scope: 'scope', versions });
    const existing = history([original]);
    const writer = new ObjectsWritable(
      { load: async () => existing, getNativeImportOperation: () => operation },
      'remote',
      {},
      {}
    );
    writer.writeMutableObject = async () => undefined;
    try {
      await Promise.all(entries.map((entry) => writer.mergeVersionHistory(history([entry]))));
      assert.deepEqual(new Set(existing.versions), new Set([original, ...entries]));
      assert.deepEqual(
        new Set(existing.versions.map((entry) => entry.hash)),
        new Set([original.hash, ...entries.map((entry) => entry.hash)])
      );
      assert.equal(new Set(existing.getAllHashesAsString()).size, 9);
    } finally {
      writer.destroy();
    }
  }
  assert.equal(operation.stats.operations, 200);
  assert.ok(operation.stats.stalePlans > 0);
});
