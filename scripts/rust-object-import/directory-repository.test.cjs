const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHook } = require('node:async_hooks');
const { root, source } = require('./load-source.cjs');
const { default: Repository } = source('scopes/scope/objects/objects/repository.ts');
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-directory-repo-'));
  const previous = process.env.BIT_RUST_OBJECT_IMPORT;
  process.env.BIT_RUST_OBJECT_IMPORT =
    process.env.BIT_TEST_OBJECT_IMPORT || path.join(root, 'native/target/debug/bit-object-import');
  t.after(async () => {
    if (previous === undefined) delete process.env.BIT_RUST_OBJECT_IMPORT;
    else process.env.BIT_RUST_OBJECT_IMPORT = previous;
    await fs.rm(dir, { recursive: true, force: true });
  });
  const repo = new Repository(dir, { name: 'directory-test' });
  repo.getPath = () => dir;
  const hashes = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0') + '0'.repeat(38));
  const bytes = zlib.deflateSync(Buffer.from('Source hash 1\0payload'));
  await Promise.all(
    hashes.map(async (hash) => {
      await fs.mkdir(path.join(dir, hash.slice(0, 2)));
      await fs.writeFile(path.join(dir, hash.slice(0, 2), hash.slice(2)), bytes);
    })
  );
  return { dir, repo, hashes };
}
const normalize = (result) => ({
  objects: result.objects
    .map(({ ref, ...rest }) => ({ hash: String(ref), ...rest }))
    .sort((a, b) => a.hash.localeCompare(b.hash)),
  unreadable: result.unreadable.map(String).sort(),
});
async function counted(run) {
  let count = 0;
  const hook = createHook({
    init(_, type) {
      if (type.startsWith('FSREQ')) count++;
    },
  });
  hook.enable();
  try {
    return { result: await run(), count };
  } finally {
    hook.disable();
  }
}

test('real inventories match canonical classification with one Node filesystem request', async (t) => {
  const { dir, repo, hashes } = await setup(t);
  const helper = process.env.BIT_RUST_OBJECT_IMPORT;
  process.env.BIT_RUST_OBJECT_IMPORT = 'off';
  const expected = normalize(await repo.listObjectsWithType());
  process.env.BIT_RUST_OBJECT_IMPORT = helper;
  const actual = await counted(() => repo.listObjectsWithType());
  assert.deepEqual(normalize(actual.result), expected);
  assert.equal(actual.count, 1, 'combined inventory must actually run native traversal and headers');
  const refs = await counted(() => repo.listRefs());
  assert.equal(refs.count, 1, 'reference inventories must actually traverse natively');
  assert.deepEqual(refs.result.map(String).sort(), hashes);
  await fs.writeFile(path.join(dir, '00', '0'.repeat(38)), 'broken');
  await fs.writeFile(path.join(dir, '01', '0'.repeat(38)), zlib.deflateSync(Buffer.from('Unregistered hash 1\0{}')));
  const directoryHash = '02' + '1'.repeat(38);
  const linkHash = '03' + '2'.repeat(38);
  await fs.mkdir(path.join(dir, '02', directoryHash.slice(2)));
  await fs.symlink(path.join(dir, 'missing'), path.join(dir, '03', linkHash.slice(2)));
  process.env.BIT_RUST_OBJECT_IMPORT = 'off';
  const incomplete = normalize(await repo.listObjectsWithType());
  process.env.BIT_RUST_OBJECT_IMPORT = helper;
  assert.deepEqual(normalize(await repo.listObjectsWithType()), incomplete);
  assert.deepEqual(incomplete.unreadable, [...hashes.slice(0, 2), directoryHash, linkHash].sort());
});

test('custom inventory/read methods and transforms retain canonical behavior', async (t) => {
  const { repo, hashes } = await setup(t);
  const refs = await repo.listRefs();
  let calls = 0;
  repo.listRefs = async () => {
    calls++;
    return refs.slice(0, 3);
  };
  assert.equal((await repo.listObjectsWithType()).objects.length, 3);
  assert.equal(calls, 1);
  delete repo.listRefs;
  const original = repo.readObjectType;
  repo.readObjectType = async function (...args) {
    calls++;
    return original.apply(this, args);
  };
  calls = 0;
  assert.equal((await repo.listObjectsWithType()).objects.length, hashes.length);
  assert.equal(calls, hashes.length);
  delete repo.readObjectType;
  repo.onRead = () => zlib.deflateSync(Buffer.from('Version hash 2\0{}'));
  const transformer = Repository.hasPostObjectReadTransformer;
  Repository.hasPostObjectReadTransformer = () => true;
  t.after(() => {
    Repository.hasPostObjectReadTransformer = transformer;
  });
  assert.ok((await repo.listObjectsWithType()).objects.every((object) => object.type === 'Version'));
});
