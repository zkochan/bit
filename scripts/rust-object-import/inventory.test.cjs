const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { root, source } = require('./load-source.cjs');
const { nativeObjectExists } = source('scopes/scope/objects/objects/rust-object-inventory.ts');
const native =
  process.env.BIT_TEST_OBJECT_IMPORT ||
  path.join(root, 'native/target/debug/bit-object-import' + (process.platform === 'win32' ? '.exe' : ''));
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
  if (process.getuid?.() !== 0) {
    await fs.chmod(path.join(dir, '00'), 0);
    try {
      assert.equal((await nativeObjectExists(dir, hashes.slice(0, 1024)))[4], false, 'inaccessible parent');
    } finally {
      await fs.chmod(path.join(dir, '00'), 0o755);
    }
  }
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

test('malformed identities, short/nonboolean responses and crashed helpers discard the entire batch', async (t) => {
  const dir = await setup(t);
  if (process.platform === 'win32') return;
  const executable = path.join(dir, 'fake-helper');
  process.env.BIT_RUST_OBJECT_IMPORT = executable;
  const valid = { version: 1, id: 1, exists: Array(1024).fill(true) };
  for (const response of [
    { ...valid, id: 2 },
    { ...valid, version: 2 },
    { ...valid, exists: [true] },
    { ...valid, exists: Array(1024).fill(1) },
    null,
  ]) {
    await fs.writeFile(
      executable,
      "#!/bin/sh\nprintf '%s' '" + JSON.stringify(response).replace(/'/g, "'\\''") + "'\n",
      { mode: 0o755 }
    );
    assert.equal(await nativeObjectExists(dir, hashes.slice(0, 1024)), undefined);
  }
  await fs.writeFile(executable, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  assert.equal(await nativeObjectExists(dir, hashes.slice(0, 1024)), undefined);
  process.env.BIT_RUST_OBJECT_IMPORT = native;
  const results = await Promise.all(Array.from({ length: 4 }, () => nativeObjectExists(dir, hashes.slice(0, 1024))));
  for (const result of results) assert.deepEqual(result, Array(1024).fill(false));
});

test('multi-frame existence operations reject missing, reordered or extra frames without partial results', async (t) => {
  const dir = await setup(t);
  if (process.platform === 'win32') return;
  const input = hashes.slice(0, 8192);
  const first = { version: 1, id: 1, exists: Array(4096).fill(false) };
  const second = { ...first, id: 2 };
  const helper = path.join(dir, 'frames.cjs');
  for (const frames of [[first], [second, first], [first, { ...second, exists: [] }], [first, second, second]]) {
    const output = frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n';
    await fs.writeFile(
      helper,
      '#!' +
        process.execPath +
        '\nprocess.stdin.resume();process.stdin.on("end",()=>process.stdout.write(' +
        JSON.stringify(output) +
        '));\n'
    );
    await fs.chmod(helper, 0o755);
    process.env.BIT_RUST_OBJECT_IMPORT = helper;
    assert.equal(await nativeObjectExists(dir, input), undefined);
  }
  process.env.BIT_RUST_OBJECT_IMPORT = native;
  process.env.BIT_RUST_OBJECT_READ_OPERATIONS = 'off';
  try {
    assert.deepEqual(await nativeObjectExists(dir, input), Array(input.length).fill(false));
  } finally {
    delete process.env.BIT_RUST_OBJECT_READ_OPERATIONS;
  }
});
