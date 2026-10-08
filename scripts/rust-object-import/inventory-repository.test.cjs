const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { root, source, installed } = require('./load-source.cjs');
const { default: Repository } = source('scopes/scope/objects/objects/repository.ts');
const { Ref } = installed('@teambit/objects');

test('hasMultiple preserves duplicate Ref identity, disk-only semantics and custom overrides', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-inventory-repository-'));
  const previous = process.env.BIT_RUST_OBJECT_IMPORT;
  process.env.BIT_RUST_OBJECT_IMPORT =
    process.env.BIT_TEST_OBJECT_IMPORT || path.join(root, 'native/target/debug/bit-object-import');
  t.after(async () => {
    if (previous === undefined) delete process.env.BIT_RUST_OBJECT_IMPORT;
    else process.env.BIT_RUST_OBJECT_IMPORT = previous;
    await fs.rm(directory, { recursive: true, force: true });
  });
  const repo = Object.create(Repository.prototype);
  repo.getPath = () => directory;
  const refs = Array.from({ length: 1024 }, (_, i) => new Ref(i.toString(16).padStart(40, '0')));
  repo.objects = { [refs[1].toString()]: {} };
  await fs.mkdir(path.join(directory, '00'));
  await fs.writeFile(repo.objectPath(refs[0]), 'object');
  const duplicate = new Ref(refs[0].toString());
  const result = await repo.hasMultiple([...refs, duplicate]);
  assert.deepEqual(result, [refs[0], duplicate]);
  assert.equal(result[1], duplicate);
  let calls = 0;
  repo.has = async (ref) => {
    calls++;
    return ref === refs[1];
  };
  assert.deepEqual(await repo.hasMultiple(refs), [refs[1]]);
  assert.equal(calls, refs.length);
  delete repo.has;
  repo.objectPath = () => path.join(directory, 'custom');
  await fs.writeFile(repo.objectPath(), 'custom');
  assert.deepEqual(await repo.hasMultiple(refs), refs);
});
