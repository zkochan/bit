const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHook } = require('node:async_hooks');
const { root, source, installed } = require('./load-source.cjs');
const { default: Repository } = source('scopes/scope/objects/objects/repository.ts');
const { Ref } = installed('@teambit/objects');
async function setup(t, count = 1024) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-read-repository-'));
  const previous = process.env.BIT_RUST_OBJECT_IMPORT;
  process.env.BIT_RUST_OBJECT_IMPORT =
    process.env.BIT_TEST_OBJECT_IMPORT || path.join(root, 'native/target/debug/bit-object-import');
  t.after(async () => {
    if (previous === undefined) delete process.env.BIT_RUST_OBJECT_IMPORT;
    else process.env.BIT_RUST_OBJECT_IMPORT = previous;
    await fs.rm(directory, { recursive: true, force: true });
  });
  const repo = new Repository(directory, { name: 'read-test' });
  repo.getPath = () => directory;
  const refs = Array.from({ length: count }, (_, i) => new Ref(i.toString(16).padStart(40, '0')));
  await fs.mkdir(path.join(directory, '00'));
  return { directory, repo, refs };
}
async function filesystemCount(fn) {
  let count = 0;
  const hook = createHook({
    init(_, type) {
      if (type.startsWith('FSREQ')) count++;
    },
  });
  hook.enable();
  try {
    return { result: await fn(), count };
  } finally {
    hook.disable();
  }
}

test('repository batch reads preserve dedup/order/Ref identity and avoid per-object Node reads', async (t) => {
  const { repo, refs } = await setup(t);
  const bytes = Buffer.from([0, 255, 17]);
  await Promise.all(refs.map((ref) => fs.writeFile(repo.objectPath(ref), bytes)));
  const { result, count } = await filesystemCount(() => repo.loadManyRaw([...refs, new Ref(refs[0].toString())]));
  assert.equal(result.length, refs.length);
  assert.equal(count, 0, 'must actually use native buffers, not silently fall back');
  result.forEach((item, index) => {
    assert.equal(item.ref, refs[index]);
    assert.deepEqual(item.buffer, bytes);
  });
  await fs.unlink(repo.objectPath(refs[1]));
  await assert.rejects(repo.loadManyRaw(refs), { code: 'ENOENT' });
  const withoutMissing = await repo.loadManyRawIgnoreMissing([...refs, refs[0]]);
  assert.equal(withoutMissing.length, refs.length);
  assert.equal(withoutMissing.at(-1).ref, refs[0]);
  let overrides = 0;
  repo.loadRaw = async () => {
    overrides++;
    return bytes;
  };
  await repo.loadManyRaw(refs);
  assert.equal(overrides, refs.length);
});

test('header classification matches canonical inventory and retains unknown/corrupt unreadable entries', async (t) => {
  const { repo, refs } = await setup(t, 256);
  const buffer = zlib.deflateSync(Buffer.from('Source hash 1\0payload'));
  await Promise.all(refs.map((ref) => fs.writeFile(repo.objectPath(ref), buffer)));
  repo.listRefs = async () => refs;
  const native = process.env.BIT_RUST_OBJECT_IMPORT;
  process.env.BIT_RUST_OBJECT_IMPORT = 'off';
  const canonical = await repo.listObjectsWithType();
  process.env.BIT_RUST_OBJECT_IMPORT = native;
  const result = await filesystemCount(() => repo.listObjectsWithType());
  assert.equal(result.count, 0);
  assert.deepEqual(result.result, canonical);
  await fs.writeFile(repo.objectPath(refs[2]), zlib.deflateSync(Buffer.from('Alien hash 1\0{}')));
  await fs.writeFile(repo.objectPath(refs[3]), Buffer.from('broken'));
  assert.deepEqual((await repo.listObjectsWithType()).unreadable, [refs[2], refs[3]]);
  repo.onRead = () => zlib.deflateSync(Buffer.from('Version hash 2\0{}'));
  Repository.hasPostObjectReadTransformer = () => true;
  t.after(() => {
    Repository.hasPostObjectReadTransformer = undefined;
  });
  const transformed = await repo.listObjectsWithType();
  assert.equal(transformed.unreadable.length, 0);
  assert.ok(transformed.objects.every((object) => object.type === 'Version'));
});
