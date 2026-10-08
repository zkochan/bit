const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { root, source } = require('./load-source.cjs');
const { nativeObjectExists } = source('scopes/scope/objects/objects/rust-object-inventory.ts');
const native = process.env.BIT_TEST_OBJECT_IMPORT || path.join(root, 'native/target/debug/bit-object-import');
const hashes = Array.from({ length: 8500 }, (_, i) => i.toString(16).padStart(40, '0'));

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-inventory-'));
  const previous = process.env.BIT_RUST_OBJECT_IMPORT;
  process.env.BIT_RUST_OBJECT_IMPORT = native;
  t.after(async () => {
    if (previous === undefined) delete process.env.BIT_RUST_OBJECT_IMPORT;
    else process.env.BIT_RUST_OBJECT_IMPORT = previous;
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('ordered inventory spans bounded frames and sees creation/deletion without stale caches', async (t) => {
  const dir = await setup(t);
  if (process.platform === 'win32') return assert.equal(await nativeObjectExists(dir, hashes), undefined);
  await fs.mkdir(path.join(dir, '00'));
  const file = path.join(dir, '00', hashes[4].slice(2));
  await fs.writeFile(file, 'opaque bytes');
  const input = [...hashes, hashes[4]];
  const result = await nativeObjectExists(dir, input);
  assert.equal(result.length, input.length);
  assert.deepEqual(
    result.flatMap((exists, i) => (exists ? [i] : [])),
    [4, hashes.length]
  );
  await fs.unlink(file);
  assert.equal((await nativeObjectExists(dir, hashes.slice(0, 1024)))[4], false);
  await fs.mkdir(file);
  assert.equal((await nativeObjectExists(dir, hashes.slice(0, 1024)))[4], true, 'pathExists includes directories');
  const link = path.join(dir, '00', hashes[5].slice(2));
  await fs.symlink(path.join(dir, 'absent'), link);
  assert.equal((await nativeObjectExists(dir, hashes.slice(0, 1024)))[5], false, 'dangling symlink');
});

test('small/invalid hashes, disabled and unavailable helpers retain canonical fallback', async (t) => {
  const dir = await setup(t);
  assert.equal(await nativeObjectExists(dir, hashes.slice(0, 1023)), undefined);
  assert.equal(await nativeObjectExists(dir, [...hashes.slice(0, 1024), '../escape']), undefined);
  process.env.BIT_RUST_OBJECT_IMPORT = path.join(dir, 'missing-helper');
  assert.equal(await nativeObjectExists(dir, hashes.slice(0, 1024)), undefined);
  process.env.BIT_RUST_OBJECT_IMPORT = 'off';
  assert.equal(await nativeObjectExists(dir, hashes.slice(0, 1024)), undefined);
});

test('partial and oversized inventory frames produce no partial success', async (t) => {
  const dir = await setup(t);
  for (const count of [0, 4097, 2]) {
    const input = Buffer.alloc(12 + (count === 2 ? 20 : 0));
    input.write('BEX1');
    input.writeUInt32BE(1, 4);
    input.writeUInt32BE(count, 8);
    const result = cp.spawnSync(native, ['--objects-dir', dir], { input });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout.length, 0);
  }
});
