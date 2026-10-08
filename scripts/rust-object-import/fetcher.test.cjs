const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { repository, item } = require('./persistence.cjs');
const { source } = require('./load-source.cjs');
const { ObjectFetcher } = source('components/legacy/scope/objects-fetcher/objects-fetcher.ts');
const executable =
  process.env.BIT_TEST_OBJECT_IMPORT ||
  path.resolve(
    __dirname,
    '../../native/target/debug',
    process.platform === 'win32' ? 'bit-object-import.exe' : 'bit-object-import'
  );
test('actual ObjectFetcher operation shares validator across remote streams and completes repository writes', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-fetcher-test-'));
  const previous = process.env.BIT_RUST_OBJECT_IMPORT;
  process.env.BIT_RUST_OBJECT_IMPORT = executable;
  t.after(async () => {
    if (previous === undefined) delete process.env.BIT_RUST_OBJECT_IMPORT;
    else process.env.BIT_RUST_OBJECT_IMPORT = previous;
    await fs.rm(directory, { recursive: true, force: true });
  });
  const repo = await repository(directory);
  const objects = await Promise.all([Buffer.from('first'), Buffer.alloc(3 * 1024 * 1024, 97)].map(item));
  const remotes = { resolve: async () => ({ fetch: async () => Readable.from(objects) }) };
  const fetcher = new ObjectFetcher(repo, { sources: {} }, remotes, {}, [], undefined, undefined, 'integration test', {
    one: objects.map((obj) => obj.ref.toString()),
    two: objects.map((obj) => obj.ref.toString()),
  });
  const hashes = await fetcher.fetchFromRemoteAndWrite();
  assert.deepEqual(
    hashes,
    objects.map((obj) => obj.ref.toString())
  );
  for (const obj of objects) assert.equal((await repo.load(obj.ref)).hash().toString(), obj.ref.toString());
});

test('ObjectFetcher disposes its helper on remote failure and missing helper preserves successful import', async (t) => {
  const { RustSourceValidator } = source('components/legacy/scope/objects-fetcher/rust-source-validator.ts');
  const original = RustSourceValidator.prototype.dispose;
  const previous = process.env.BIT_RUST_OBJECT_IMPORT;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-fetcher-fallback-'));
  let disposed = 0;
  RustSourceValidator.prototype.dispose = function () {
    disposed++;
    return original.call(this);
  };
  t.after(async () => {
    RustSourceValidator.prototype.dispose = original;
    if (previous === undefined) delete process.env.BIT_RUST_OBJECT_IMPORT;
    else process.env.BIT_RUST_OBJECT_IMPORT = previous;
    await fs.rm(directory, { recursive: true, force: true });
  });
  const repo = await repository(directory);
  const obj = await item(Buffer.from('fallback'));
  process.env.BIT_RUST_OBJECT_IMPORT = executable;
  const failure = new ObjectFetcher(
    repo,
    { sources: {} },
    {
      resolve: async () => {
        throw new Error('remote failed');
      },
    },
    {},
    [],
    undefined,
    undefined,
    undefined,
    { one: [obj.ref.toString()] }
  );
  await assert.rejects(failure.fetchFromRemoteAndWrite(), /remote failed/);
  assert.equal(disposed, 1);
  process.env.BIT_RUST_OBJECT_IMPORT = path.join(directory, 'missing-helper');
  const success = new ObjectFetcher(
    repo,
    { sources: {} },
    { resolve: async () => ({ fetch: async () => Readable.from([obj]) }) },
    {},
    [],
    undefined,
    undefined,
    undefined,
    { one: [obj.ref.toString()] }
  );
  assert.deepEqual(await success.fetchFromRemoteAndWrite(), [obj.ref.toString()]);
  assert.equal(disposed, 2);
  assert.equal((await repo.load(obj.ref)).hash().toString(), obj.ref.toString());
});
