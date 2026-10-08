const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { source, root } = require('./load-source.cjs');
const { nativeObjectBuffers } = source('scopes/scope/objects/objects/rust-object-reader.ts');
const native =
  process.env.BIT_TEST_OBJECT_IMPORT ||
  path.join(root, 'native/target/debug/bit-object-import' + (process.platform === 'win32' ? '.exe' : ''));
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bit read budget λ '));
  const keys = ['BIT_RUST_OBJECT_IMPORT', 'BIT_RUST_OBJECT_READ_BUDGET'];
  const previous = keys.map((key) => process.env[key]);
  process.env.BIT_RUST_OBJECT_IMPORT = native;
  delete process.env.BIT_RUST_OBJECT_READ_BUDGET;
  t.after(async () => {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    await fs.rm(dir, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(dir, '00'));
  return dir;
}
const hash = '0'.repeat(39) + '1';
const hashes = Array(1024).fill(hash);
test('checked raw reads keep the inclusive byte boundary, fallback above it and preserve rollback', async (t) => {
  const dir = await setup(t);
  const file = path.join(dir, '00', hash.slice(2));
  const bytes = Buffer.alloc(4096, 17);
  await fs.writeFile(file, bytes);
  assert.ok((await nativeObjectBuffers(dir, hashes)).every((buffer) => buffer.equals(bytes)));
  assert.equal(await nativeObjectBuffers(dir, [...hashes, hash]), undefined);
  process.env.BIT_RUST_OBJECT_READ_BUDGET = 'off';
  assert.ok((await nativeObjectBuffers(dir, [...hashes, hash])).every((buffer) => buffer.equals(bytes)));
  delete process.env.BIT_RUST_OBJECT_READ_BUDGET;
  await fs.unlink(file);
  assert.equal(await nativeObjectBuffers(dir, hashes), undefined);
  await fs.writeFile(file, Buffer.alloc(0));
  assert.ok((await nativeObjectBuffers(dir, hashes)).every((buffer) => buffer.length === 0));
});
test('checked operation validates the entire request before output and skips ineligible transfer', async (t) => {
  const dir = await setup(t);
  const input = (id, count, complete = true) => {
    const bytes = Buffer.alloc(12 + (complete ? count * 20 : 20));
    bytes.write('BRC1');
    bytes.writeUInt32BE(id, 4);
    bytes.writeUInt32BE(count, 8);
    for (let offset = 12; offset < bytes.length; offset += 20) Buffer.from(hash, 'hex').copy(bytes, offset);
    return bytes;
  };
  for (const frame of [input(2, 1), input(1, 0), input(1, 4097), input(1, 2, false)]) {
    const child = cp.spawnSync(native, ['--objects-dir', dir], { input: frame });
    assert.notEqual(child.status, 0);
    assert.equal(child.stdout.length, 0);
  }
  const file = path.join(dir, '00', hash.slice(2));
  for (const bytes of [64 * 1024, 256 * 1024 + 1]) {
    await fs.writeFile(file, Buffer.alloc(bytes, 17));
    const child = cp.spawnSync(native, ['--objects-dir', dir], { input: input(1, 1024) });
    assert.equal(child.status, 0);
    assert.equal(child.stdout.length, 0);
  }
});
