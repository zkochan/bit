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
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bit native read λ '));
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

test('oversized total transfer discards the complete group and leaves later requests usable', async (t) => {
  const dir = await setup(t);
  await fs.writeFile(file(dir, 0), Buffer.alloc(256 * 1024, 17));
  assert.equal(await nativeObjectBuffers(dir, Array(1024).fill(hashes[0])), undefined);
  assert.equal((await nativeObjectBuffers(dir, hashes))[0].length, 256 * 1024);
});

test('malformed binary boundaries/identities and header records never expose an accepted prefix', async (t) => {
  const dir = await setup(t);
  if (process.platform === 'win32') return;
  const executable = path.join(dir, 'fake-helper');
  process.env.BIT_RUST_OBJECT_IMPORT = executable;
  const raw = [];
  for (let start = 0; start < 1024; start += 128) {
    const frame = Buffer.alloc(12 + 128 * 6);
    frame.write('BRD1');
    frame.writeUInt32BE(start / 128 + 1, 4);
    frame.writeUInt32BE(128, 8);
    for (let index = 0; index < 128; index++) {
      const offset = 12 + index * 6;
      frame[offset] = 1;
      frame.writeUInt32BE(1, offset + 1);
      frame[offset + 5] = 17;
    }
    raw.push(frame);
  }
  const valid = Buffer.concat(raw);
  const wrongLastId = Buffer.from(valid);
  wrongLastId.writeUInt32BE(999, valid.length - raw.at(-1).length + 4);
  const oversized = Buffer.from(valid);
  oversized.writeUInt32BE(256 * 1024 + 1, 13);
  const invalidStatus = Buffer.from(valid);
  invalidStatus[12] = 2;
  const respond = async (buffer) => {
    await fs.writeFile(
      executable,
      '#!' +
        process.execPath +
        '\nprocess.stdin.resume();process.stdin.once("end",()=>process.stdout.write(Buffer.from(' +
        JSON.stringify(buffer.toString('hex')) +
        ',"hex")));\n',
      { mode: 0o755 }
    );
  };
  for (const response of [
    wrongLastId,
    oversized,
    invalidStatus,
    valid.subarray(0, -1),
    Buffer.concat([valid, Buffer.from([0])]),
  ]) {
    await respond(response);
    assert.equal(await nativeObjectBuffers(dir, hashes), undefined);
  }
  await respond(valid);
  const result = await nativeObjectBuffers(dir, hashes);
  assert.equal(result.length, 1024);
  assert.ok(result.every((buffer) => buffer.equals(Buffer.from([17]))));
  for (const header of [
    { type: 'Source', size: -1, mtimeMs: 1 },
    { type: 'Source ', size: 1, mtimeMs: 1 },
    { type: 'Source', size: 1, mtimeMs: 'now' },
  ]) {
    await respond(Buffer.from(JSON.stringify({ version: 1, id: 1, objects: Array(256).fill(header) })));
    assert.equal(await nativeObjectHeaders(dir, hashes.slice(0, 256)), undefined);
  }
});

test('header operations span bounded frames and reject a corrupt later frame atomically', async (t) => {
  const dir = await setup(t);
  if (process.platform === 'win32') return;
  const input = Array.from({ length: 16385 }, (_, i) => i.toString(16).padStart(40, '0'));
  await fs.writeFile(file(dir, 1), object('fixture'));
  const results = await nativeObjectHeaders(dir, input);
  assert.equal(results.length, input.length);
  assert.equal(results[1].type, 'Source');
  assert.equal(results.filter(Boolean).length, 1);
  const helper = path.join(dir, 'header-frames.cjs');
  const first = { version: 1, id: 1, objects: Array(4096).fill(null) };
  for (const second of [
    { ...first, id: 1 },
    { ...first, id: 2, objects: [] },
    { ...first, id: 2, objects: [false, ...Array(4095).fill(null)] },
  ]) {
    await fs.writeFile(
      helper,
      '#!' +
        process.execPath +
        '\nprocess.stdin.resume();process.stdin.on("end",()=>process.stdout.write(' +
        JSON.stringify(JSON.stringify(first) + '\n' + JSON.stringify(second) + '\n') +
        '));\n'
    );
    await fs.chmod(helper, 0o755);
    process.env.BIT_RUST_OBJECT_IMPORT = helper;
    assert.equal(await nativeObjectHeaders(dir, input.slice(0, 8192)), undefined);
  }
});

test('Windows enables existence and raw reads while retaining header and traversal restrictions', async (t) => {
  await setup(t);
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const { nativeInventoryEnabled } = source('scopes/scope/objects/objects/rust-object-inventory.ts');
  const { nativeReadsEnabled, nativeHeadersEnabled } = source('scopes/scope/objects/objects/rust-object-reader.ts');
  const { nativeTraversalEnabled } = source('scopes/scope/objects/objects/rust-object-directory.ts');
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    assert.equal(nativeInventoryEnabled(1024), true);
    assert.equal(nativeReadsEnabled(1024), true);
    assert.equal(nativeInventoryEnabled(1023), false);
    assert.equal(nativeReadsEnabled(1023), false);
    assert.equal(nativeHeadersEnabled(1024), false);
    assert.equal(nativeTraversalEnabled(), false);
    process.env.BIT_RUST_OBJECT_IMPORT = 'off';
    assert.equal(nativeInventoryEnabled(1024), false);
    assert.equal(nativeReadsEnabled(1024), false);
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
});

test('read and existence coordinators discard malformed or failed replies on every platform', async (t) => {
  const dir = await setup(t);
  const { nativeObjectExists } = source('scopes/scope/objects/objects/rust-object-inventory.ts');
  const original = cp.execFile;
  let reply;
  let failure;
  cp.execFile = (_executable, _args, _options, callback) => ({
    stdin: {
      on() {},
      end() {
        queueMicrotask(() => callback(failure, reply));
      },
    },
  });
  try {
    const frames = Array.from({ length: 8 }, (_, index) => {
      const frame = Buffer.alloc(12 + 128);
      frame.write('BRD1');
      frame.writeUInt32BE(index + 1, 4);
      frame.writeUInt32BE(128, 8);
      return frame;
    });
    const valid = Buffer.concat(frames);
    const reordered = Buffer.from(valid);
    reordered.writeUInt32BE(99, frames[0].length + 4);
    for (reply of [valid.subarray(0, -1), reordered, Buffer.concat([valid, Buffer.from([0])])])
      assert.equal(await nativeObjectBuffers(dir, hashes), undefined);
    reply = valid;
    assert.deepEqual(await nativeObjectBuffers(dir, hashes), Array(1024).fill(undefined));
    for (const value of [
      { version: 1, id: 2, exists: Array(1024).fill(true) },
      { version: 1, id: 1, exists: Array(1024).fill(1) },
      { version: 1, id: 1, exists: [true] },
    ]) {
      reply = Buffer.from(JSON.stringify(value) + '\n');
      assert.equal(await nativeObjectExists(dir, hashes), undefined);
    }
    reply = Buffer.from(JSON.stringify({ version: 1, id: 1, exists: Array(1024).fill(true) }) + '\n');
    assert.deepEqual(await nativeObjectExists(dir, hashes), Array(1024).fill(true));
    failure = new Error('helper failed after producing output');
    assert.equal(await nativeObjectExists(dir, hashes), undefined);
    assert.equal(await nativeObjectBuffers(dir, hashes), undefined);
  } finally {
    cp.execFile = original;
  }
});
