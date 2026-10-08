const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const zlib = require('node:zlib');
const { root, source } = require('./load-source.cjs');
const { nativeObjectBuffers, nativeObjectHeaders } = source('scopes/scope/objects/objects/rust-object-reader.ts');
const native =
  process.env.BIT_TEST_OBJECT_IMPORT ||
  path.join(root, 'native/target/debug/bit-object-import' + (process.platform === 'win32' ? '.exe' : ''));
const hashes = Array.from({ length: 1024 }, (_, index) => index.toString(16).padStart(40, '0'));
async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-native-read-'));
  const previous = process.env.BIT_RUST_OBJECT_IMPORT;
  process.env.BIT_RUST_OBJECT_IMPORT = native;
  t.after(async () => {
    if (previous === undefined) delete process.env.BIT_RUST_OBJECT_IMPORT;
    else process.env.BIT_RUST_OBJECT_IMPORT = previous;
    await fs.rm(directory, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(directory, '00'));
  return directory;
}
const file = (directory, index) => path.join(directory, '00', hashes[index].slice(2));
const object = (body, header = 'Source hash 1') =>
  zlib.deflateSync(Buffer.concat([Buffer.from(header + '\0'), Buffer.from(body)]));

test('binary read batches preserve exact bytes/emptiness/order and bound oversized fallback', async (t) => {
  const dir = await setup(t);
  if (process.platform === 'win32') return assert.equal(await nativeObjectBuffers(dir, hashes), undefined);
  const bytes = Buffer.from([0, 255, 254, 1]);
  await fs.writeFile(file(dir, 1), bytes);
  await fs.writeFile(file(dir, 2), Buffer.alloc(0));
  await fs.writeFile(file(dir, 3), Buffer.alloc(256 * 1024, 63));
  await fs.writeFile(file(dir, 4), Buffer.alloc(256 * 1024 + 1));
  const result = await nativeObjectBuffers(dir, [...hashes, hashes[1]]);
  assert.equal(result.length, hashes.length + 1);
  assert.deepEqual(result[1], bytes);
  assert.deepEqual(result[2], Buffer.alloc(0));
  assert.deepEqual(result[3], Buffer.alloc(256 * 1024, 63));
  assert.equal(result[4], undefined);
  assert.equal(result[0], undefined);
  assert.deepEqual(result.at(-1), bytes);
  assert.equal(await nativeObjectBuffers(dir, hashes.slice(0, 1023)), undefined);
});

test('header inventory reports stat size/time, accepts opaque registered types and falls back conservatively', async (t) => {
  const dir = await setup(t);
  if (process.platform === 'win32') return assert.equal(await nativeObjectHeaders(dir, hashes), undefined);
  const sourceBytes = object(Buffer.alloc(2 * 1024 * 1024, 97));
  await fs.writeFile(file(dir, 1), sourceBytes);
  await fs.writeFile(file(dir, 2), object('{}', 'UnknownType hash 2'));
  await fs.writeFile(file(dir, 3), object('x', 'Source ' + 'x'.repeat(300)));
  await fs.writeFile(file(dir, 4), Buffer.from('broken'));
  const result = await nativeObjectHeaders(dir, hashes);
  const stat = await fs.stat(file(dir, 1));
  assert.deepEqual(result[1], { type: 'Source', size: stat.size, mtimeMs: stat.mtimeMs });
  assert.equal(result[2].type, 'UnknownType', 'canonical registry remains in Node');
  assert.equal(result[0], undefined);
  assert.equal(result[3], undefined);
  assert.equal(result[4], undefined);
  assert.equal(await nativeObjectHeaders(dir, hashes.slice(0, 255)), undefined);
});

test('read-only frame bounds and truncation never produce partial success', async (t) => {
  const dir = await setup(t);
  for (const [magic, count] of [
    ['BRD1', 129],
    ['BHD1', 4097],
    ['BRD1', 2],
    ['BHD1', 2],
  ]) {
    const input = Buffer.alloc(12 + (count === 2 ? 20 : 0));
    input.write(magic);
    input.writeUInt32BE(1, 4);
    input.writeUInt32BE(count, 8);
    const result = cp.spawnSync(native, ['--objects-dir', dir], { input });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout.length, 0);
  }
});

test('native header success agrees with Node partial inflation across truncation and prefix corruption', async (t) => {
  const dir = await setup(t);
  if (process.platform === 'win32') return;
  const bytes = object(Buffer.alloc(1024 * 1024, 97));
  const corpus = [];
  for (let length = 0; length < Math.min(bytes.length, 512); length++) corpus.push(bytes.subarray(0, length));
  for (let offset = 0; offset < Math.min(bytes.length, 512); offset++) {
    const corrupt = Buffer.from(bytes.subarray(0, 512));
    corrupt[offset] ^= 255;
    corpus.push(corrupt);
  }
  await Promise.all(corpus.map((buffer, index) => fs.writeFile(file(dir, index), buffer)));
  const results = await nativeObjectHeaders(dir, hashes.slice(0, corpus.length));
  let nativeSuccesses = 0;
  results.forEach((result, index) => {
    if (!result) return;
    nativeSuccesses++;
    const inflated = zlib.inflateSync(corpus[index], { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    const end = inflated.indexOf(0);
    assert.ok(end >= 0);
    assert.equal(result.type, inflated.subarray(0, end).toString().split(' ')[0]);
  });
  assert.ok(nativeSuccesses > 100, 'exercise native successes as well as fallback');
});
