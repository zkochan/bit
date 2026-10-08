const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { repository, persist, item, Ref } = require('./persistence.cjs');
const executable =
  process.env.BIT_TEST_OBJECT_IMPORT ||
  path.resolve(
    __dirname,
    '../../native/target/debug',
    process.platform === 'win32' ? 'bit-object-import.exe' : 'bit-object-import'
  );
async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-import-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return repository(directory);
}
for (const mode of ['legacy', 'control', 'native']) {
  test(`${mode}: real atomic persistence, ordered deduplication and subsequent reads`, async (t) => {
    const previous = process.env.BIT_RUST_OBJECT_IMPORT;
    process.env.BIT_RUST_OBJECT_IMPORT = mode === 'control' ? 'control' : 'off';
    t.after(() =>
      previous === undefined
        ? delete process.env.BIT_RUST_OBJECT_IMPORT
        : (process.env.BIT_RUST_OBJECT_IMPORT = previous)
    );
    const repo = await temporary(t);
    const contents = [
      Buffer.alloc(0),
      Buffer.from('héllo 🌎'),
      Buffer.from([0, 255, 128]),
      Buffer.alloc(5 * 1024 * 1024, 97),
    ];
    const items = await Promise.all(contents.map(item));
    const result = await persist(repo, [...items, ...items], mode === 'native' ? executable : undefined);
    assert.deepEqual(
      result.hashes,
      items.map(({ ref }) => ref.toString())
    );
    if (mode === 'native') assert.equal(result.stats.sources, 8);
    for (let i = 0; i < items.length; i++) {
      const loaded = await repo.load(items[i].ref);
      assert.deepEqual(loaded.contents, contents[i]);
      if (mode !== 'legacy') assert.deepEqual(await fs.readFile(repo.objectPath(items[i].ref)), items[i].buffer);
    }
  });
}
test('native writes invoke persist hook, invalidate caches and preserve existing mode', async (t) => {
  const repo = await temporary(t);
  const obj = await item(Buffer.from('fresh contents'));
  await persist(repo, [obj]);
  const stale = await repo.load(obj.ref);
  stale.contents = Buffer.from('stale cache');
  const file = repo.objectPath(obj.ref);
  await fs.chmod(file, 0o640);
  let calls = 0;
  repo.onPersist = (buffer) => {
    calls++;
    return buffer;
  };
  await persist(repo, [obj], executable);
  assert.equal(calls, 1);
  assert.deepEqual((await repo.load(obj.ref)).contents, Buffer.from('fresh contents'));
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o640);
});
test('failed write preserves cached object; invalid ref cannot escape repository', async (t) => {
  const repo = await temporary(t);
  const obj = await item(Buffer.from('cached'));
  await persist(repo, [obj]);
  const cached = await repo.load(obj.ref);
  repo.onPersist = () => {
    throw new Error('persist hook failed');
  };
  await assert.rejects(persist(repo, [obj], executable), /persist hook failed/);
  assert.equal(await repo.load(obj.ref), cached);
  await assert.rejects(repo.writeValidatedSourceToFS(new Ref('../escape'), obj.buffer), /invalid validated Source ref/);
});
test('wire identity mismatch retains legacy content identity and corruption errors', async (t) => {
  const repo = await temporary(t);
  const obj = await item(Buffer.from('content identity'));
  const wrong = new Ref('0'.repeat(40));
  const result = await persist(repo, [{ ref: wrong, buffer: obj.buffer }], executable);
  assert.equal(result.stats.sources, 0);
  assert.equal(await repo.has(wrong), false);
  assert.deepEqual((await repo.load(obj.ref)).contents, Buffer.from('content identity'));
  let legacy;
  try {
    await persist(repo, [{ ref: obj.ref, buffer: Buffer.from('corrupt') }]);
  } catch (error) {
    legacy = error;
  }
  await assert.rejects(
    persist(repo, [{ ref: obj.ref, buffer: Buffer.from('corrupt') }], executable),
    (error) => error.constructor === legacy.constructor && error.message === legacy.message
  );
});

test('mutable histories merge and duplicate components remain available to the legacy merger', async (t) => {
  const { installed, source } = require('./load-source.cjs');
  const { VersionHistory, ModelComponent, Lane, LaneHistory } = installed('@teambit/objects');
  const { ObjectsWritable } = source('components/legacy/scope/objects-fetcher/objects-writable-stream.ts');
  const { WriteObjectsQueue } = source('components/legacy/scope/objects-fetcher/write-objects-queue.ts');
  const { RustSourceValidator } = source('components/legacy/scope/objects-fetcher/rust-source-validator.ts');
  const { Readable } = require('node:stream');
  const { pipeline } = require('node:stream/promises');
  const repo = await temporary(t);
  const oldHash = new Ref('1'.repeat(40)),
    newHash = new Ref('2'.repeat(40));
  await repo.writeObjectsToTheFS([
    new VersionHistory({ name: 'component', scope: 'test.remote', versions: [{ hash: oldHash, parents: [] }] }),
  ]);
  const history = new VersionHistory({
    name: 'component',
    scope: 'test.remote',
    versions: [{ hash: newHash, parents: [oldHash] }],
  });
  const component = ModelComponent.from({ name: 'component', scope: 'test.remote' });
  const lane = Lane.create('development', 'test.remote');
  const laneHistory = LaneHistory.fromLaneObject(lane);
  const objects = [history, laneHistory, component, component];
  const items = await Promise.all(objects.map(async (obj) => ({ ref: obj.hash(), buffer: await obj.compress() })));
  const validator = new RustSourceValidator(executable);
  t.after(() => validator.dispose());
  const queue = new WriteObjectsQueue();
  const components = {};
  await pipeline(Readable.from(items), new ObjectsWritable(repo, 'test.remote', queue, components, validator));
  await queue.onIdle();
  assert.equal(validator.stats.sources, 0);
  assert.equal(components['test.remote'].length, 2);
  assert.deepEqual((await repo.load(history.hash())).versions.map((v) => v.hash.toString()).sort(), [
    oldHash.toString(),
    newHash.toString(),
  ]);
  assert.equal((await repo.load(laneHistory.hash())).getType(), 'LaneHistory');
  const laneItem = { ref: lane.hash(), buffer: await lane.compress() };
  await assert.rejects(persist(repo, [laneItem], executable), /ObjectsWritable does not support lanes/);
});

test('buffered native imports use bounded batches and preserve write/deduplication order', async (t) => {
  const repo = await temporary(t);
  const objects = await Promise.all(Array.from({ length: 80 }, (_, i) => item(Buffer.from(`source ${i}`))));
  const result = await persist(repo, objects, executable);
  assert.deepEqual(
    result.hashes,
    objects.map((obj) => obj.ref.toString())
  );
  assert.equal(result.stats.sources, 80);
  assert.ok(result.stats.batches < 15, `expected bounded buffered validation, got ${result.stats.batches} round trips`);
  for (const obj of objects) assert.equal((await repo.load(obj.ref)).hash().toString(), obj.ref.toString());
});

test('buffered native fallback preserves legacy error and earlier immutable writes', async (t) => {
  const repo = await temporary(t);
  const objects = await Promise.all(Array.from({ length: 8 }, (_, i) => item(Buffer.from(`prefix ${i}`))));
  const corrupt = { ref: new Ref('f'.repeat(40)), buffer: Buffer.from('corrupt compression') };
  let legacyError;
  try {
    await persist(repo, [...objects, corrupt]);
  } catch (error) {
    legacyError = error;
  }
  const nativeRepo = await temporary(t);
  await assert.rejects(
    persist(nativeRepo, [...objects, corrupt], executable),
    (error) => error.constructor === legacyError.constructor && error.message === legacyError.message
  );
  for (const obj of objects) assert.equal((await nativeRepo.load(obj.ref)).hash().toString(), obj.ref.toString());
});

test('native store eligibility respects instance transforms and live extension slots', async (t) => {
  const { source } = require('./load-source.cjs');
  const { default: CurrentRepository } = source('scopes/scope/objects/objects/repository.ts');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-store-hooks-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const previous = Object.fromEntries(
    ['onPreObjectPersist', 'onPostObjectRead', 'hasPreObjectPersistTransformer', 'hasPostObjectReadTransformer'].map(
      (key) => [key, CurrentRepository[key]]
    )
  );
  t.after(() => Object.assign(CurrentRepository, previous));
  CurrentRepository.onPreObjectPersist = undefined;
  CurrentRepository.onPostObjectRead = undefined;
  CurrentRepository.hasPreObjectPersistTransformer = undefined;
  CurrentRepository.hasPostObjectReadTransformer = undefined;
  const repo = new CurrentRepository(directory, { name: 'hook-test' });
  repo.getChownOptions = async () => null;
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    assert.equal(await repo.getNativeSourceStoreOptions(), undefined);
    return;
  }
  assert.equal((await repo.getNativeSourceStoreOptions()).objectsDirectory, path.resolve(repo.getPath()));
  const persistHook = repo.onPersist;
  repo.onPersist = (buffer) => buffer;
  assert.equal(await repo.getNativeSourceStoreOptions(), undefined);
  repo.onPersist = persistHook;
  const readHook = repo.onRead;
  repo.onRead = (buffer) => buffer;
  assert.equal(await repo.getNativeSourceStoreOptions(), undefined);
  repo.onRead = readHook;
  CurrentRepository.onPreObjectPersist = (buffer) => buffer;
  assert.equal(await repo.getNativeSourceStoreOptions(), undefined);
  let active = false;
  CurrentRepository.hasPreObjectPersistTransformer = () => active;
  assert.ok(await repo.getNativeSourceStoreOptions());
  active = true;
  assert.equal(await repo.getNativeSourceStoreOptions(), undefined);
  active = false;
  CurrentRepository.onPostObjectRead = (buffer) => buffer;
  assert.equal(await repo.getNativeSourceStoreOptions(), undefined);
  CurrentRepository.hasPostObjectReadTransformer = () => active;
  assert.ok(await repo.getNativeSourceStoreOptions());
  active = true;
  assert.equal(await repo.getNativeSourceStoreOptions(), undefined);
});

test('Rust batch writes preserve prefix persistence before a canonical corrupt-object error', async (t) => {
  const { source } = require('./load-source.cjs');
  const { RustObjectImporter } = source('components/legacy/scope/objects-fetcher/rust-object-importer.ts');
  const { ObjectsWritable } = source('components/legacy/scope/objects-fetcher/objects-writable-stream.ts');
  const { WriteObjectsQueue } = source('components/legacy/scope/objects-fetcher/write-objects-queue.ts');
  const { Readable } = require('node:stream');
  const { pipeline } = require('node:stream/promises');
  const repo = await temporary(t);
  const items = await Promise.all(Array.from({ length: 8 }, (_, i) => item(Buffer.from(`prefix-${i}`))));
  const queue = new WriteObjectsQueue();
  const importer = new RustObjectImporter(executable, { objectsDirectory: path.resolve(repo.getPath()) });
  t.after(() => importer.dispose());
  await assert.rejects(
    pipeline(
      Readable.from([...items, { ref: new Ref('0'.repeat(40)), buffer: Buffer.from('corrupt') }]),
      new ObjectsWritable(repo, 'prefix', queue, {}, undefined, importer)
    )
  );
  assert.deepEqual(
    queue.addedHashes,
    items.map(({ ref }) => ref.toString())
  );
  for (const obj of items) assert.equal((await repo.load(obj.ref)).hash().toString(), obj.ref.toString());
  assert.equal(importer.stats.persisted, 8);
});

test('Rust commits keep the first duplicate buffer, preserve mode, and invalidate stale caches', async (t) => {
  const { source } = require('./load-source.cjs');
  const { RustObjectImporter } = source('components/legacy/scope/objects-fetcher/rust-object-importer.ts');
  const { ObjectsWritable } = source('components/legacy/scope/objects-fetcher/objects-writable-stream.ts');
  const { WriteObjectsQueue } = source('components/legacy/scope/objects-fetcher/write-objects-queue.ts');
  const { Readable } = require('node:stream');
  const { pipeline } = require('node:stream/promises');
  const zlib = require('node:zlib');
  const repo = await temporary(t);
  const obj = await item(Buffer.alloc(1024, 97));
  await persist(repo, [obj]);
  const stale = await repo.load(obj.ref);
  stale.contents = Buffer.from('stale');
  if (process.platform !== 'win32') await fs.chmod(repo.objectPath(obj.ref), 0o640);
  const duplicate = { ...obj, buffer: zlib.deflateSync(zlib.inflateSync(obj.buffer), { level: 0 }) };
  const queue = new WriteObjectsQueue();
  const importer = new RustObjectImporter(executable, { objectsDirectory: path.resolve(repo.getPath()) });
  t.after(() => importer.dispose());
  await pipeline(
    Readable.from([obj, duplicate]),
    new ObjectsWritable(repo, 'duplicate', queue, {}, undefined, importer)
  );
  assert.equal(importer.stats.persisted, 1);
  assert.equal(queue.added, 1);
  assert.deepEqual(queue.addedHashes, [obj.ref.toString()]);
  assert.deepEqual(await fs.readFile(repo.objectPath(obj.ref)), obj.buffer);
  assert.deepEqual((await repo.load(obj.ref)).contents, Buffer.alloc(1024, 97));
  if (process.platform !== 'win32') assert.equal((await fs.stat(repo.objectPath(obj.ref))).mode & 0o777, 0o640);
});
