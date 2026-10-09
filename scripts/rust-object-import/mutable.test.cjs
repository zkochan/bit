const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const zlib = require('node:zlib');
const { root, source } = require('./load-source.cjs');
const { RustObjectImporter } = source('components/legacy/scope/objects-fetcher/rust-object-importer.ts');
const native =
  process.env.BIT_TEST_OBJECT_IMPORT ||
  path.join(root, 'native/target/debug/bit-object-import' + (process.platform === 'win32' ? '.exe' : ''));
function item(type, value, index = 1) {
  const hash = index.toString(16).padStart(40, '0');
  const body = Buffer.from(JSON.stringify(value));
  return {
    ref: { toString: () => hash },
    buffer: Buffer.concat([Buffer.from(`${type} ${hash} ${body.toString().length}\0`), body]),
  };
}
const filename = (directory, object) =>
  path.join(directory, object.ref.toString().slice(0, 2), object.ref.toString().slice(2));
async function setup(t, executable = native, timeout = 10000, args = []) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-mutable-test-'));
  const writer = new RustObjectImporter(executable, { objectsDirectory: directory }, timeout, args);
  t.after(async () => {
    writer.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, writer };
}
test('native mutable compression preserves canonical serialized bytes and repeated replacements', async (t) => {
  const { directory, writer } = await setup(t);
  const objects = ['Version', 'VersionHistory', 'LaneHistory'].map((type, index) =>
    item(
      type,
      { name: '🚀 日本語', history: { entry: { log: { date: '10' }, updateDependents: [], deleted: ['scope/a'] } } },
      index + 1
    )
  );
  const sizes = await writer.persistMetadata(objects);
  assert.equal(sizes.length, objects.length);
  for (let index = 0; index < objects.length; index++) {
    const compressed = await fs.readFile(filename(directory, objects[index]));
    assert.equal(sizes[index], compressed.length);
    assert.deepEqual(zlib.inflateSync(compressed), objects[index].buffer);
  }
  const updated = item('VersionHistory', { graphCompleteRefs: ['new'], versions: [], scope: 'updated' });
  assert.ok((await writer.persistMetadata([updated]))[0]);
  assert.deepEqual(zlib.inflateSync(await fs.readFile(filename(directory, updated))), updated.buffer);
  assert.deepEqual(
    (await fs.readdir(path.join(directory, '00'))).sort(),
    objects.map((object) => object.ref.toString().slice(2)).sort(),
    'no temporary files remain'
  );
});
test('unsupported types, mismatched identities and failed writes retain per-object fallback', async (t) => {
  const { directory, writer } = await setup(t);
  const unknown = item('ModelComponent', {}, 1);
  const sourceObject = item('Source', {}, 2);
  const mismatch = item('Version', {}, 3);
  mismatch.ref = { toString: () => '4'.padStart(40, '0') };
  const valid = item('LaneHistory', { history: {} }, 5);
  const sizes = await writer.persistMetadata([unknown, sourceObject, mismatch, valid]);
  assert.deepEqual(sizes, [null, null, null, (await fs.stat(filename(directory, valid))).size]);
  for (const object of [unknown, sourceObject, mismatch])
    await assert.rejects(fs.access(filename(directory, object)), { code: 'ENOENT' });
  const blocked = item('Version', {}, 6);
  await fs.mkdir(filename(directory, blocked));
  assert.deepEqual(await writer.persistMetadata([blocked]), [null]);
});
test('bounds and duplicate identities fail before writing any partial batch', async (t) => {
  const { directory, writer } = await setup(t);
  const object = item('Version', {});
  assert.equal(await writer.persistMetadata([object, object]), undefined);
  assert.equal(await writer.persistMetadata([{ ...object, buffer: Buffer.alloc(512 * 1024 + 1) }]), undefined);
  const frame = Buffer.alloc(12 + 24 + object.buffer.length + 24);
  frame.write('BMP1');
  frame.writeUInt32BE(1, 4);
  frame.writeUInt32BE(2, 8);
  Buffer.from(object.ref.toString(), 'hex').copy(frame, 12);
  frame.writeUInt32BE(object.buffer.length, 32);
  object.buffer.copy(frame, 36);
  Buffer.from('2'.padStart(40, '0'), 'hex').copy(frame, 36 + object.buffer.length);
  frame.writeUInt32BE(100, 56 + object.buffer.length);
  const result = cp.spawnSync(native, ['--objects-dir', directory], { input: frame });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.length, 0);
  assert.deepEqual(await fs.readdir(directory), []);
});
test('maximum serialized size is accepted and concurrent operation requests stay ordered', async (t) => {
  const { directory, writer } = await setup(t);
  const hash = '1'.padStart(40, '0');
  const prefix = Buffer.from(`Version ${hash} 0\0`);
  const largest = {
    ref: { toString: () => hash },
    buffer: Buffer.concat([prefix, Buffer.alloc(512 * 1024 - prefix.length, 97)]),
  };
  assert.ok((await writer.persistMetadata([largest]))[0]);
  assert.deepEqual(zlib.inflateSync(await fs.readFile(filename(directory, largest))), largest.buffer);
  const replacements = Array.from({ length: 16 }, (_, index) => item('Version', { index }));
  assert.ok(
    (await Promise.all(replacements.map((value) => writer.persistMetadata([value])))).every((value) => value[0])
  );
  assert.deepEqual(zlib.inflateSync(await fs.readFile(filename(directory, largest))), replacements.at(-1).buffer);
});
test('missing helpers and invalid response coverage fall back without hanging', async (t) => {
  const { directory, writer } = await setup(t, path.join(os.tmpdir(), 'missing-bit-mutable-helper'));
  assert.equal(await writer.persistMetadata([item('Version', {})]), undefined);
  const replies = [[], [0], [-1], [1.5], ['1'], [999999]].map((sizes) => ({ version: 1, id: 1, sizes }));
  replies.push({ version: 2, id: 1, sizes: [1] }, { version: 1, id: 2, sizes: [1] });
  for (const response of replies) {
    const script = path.join(directory, 'fake.cjs');
    await fs.writeFile(
      script,
      `process.stdin.once('data',()=>process.stdout.write(${JSON.stringify(JSON.stringify(response) + '\n')}));`
    );
    const fake = new RustObjectImporter(process.execPath, { objectsDirectory: directory }, 2000, [script]);
    assert.equal(await fake.persistMetadata([item('Version', {})]), undefined);
    assert.match(fake.unavailableReason, /invalid mutable write response/);
    fake.dispose();
  }
});
test(
  'mutable timeout waits for helper exit before permitting canonical retry',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { directory } = await setup(t);
    const marker = path.join(directory, 'late-write');
    const script = path.join(directory, 'slow.cjs');
    await fs.writeFile(
      script,
      `const fs=require('node:fs'); let requests=0;
    process.on('SIGTERM',()=>{}); process.stdin.on('data',()=>{
      if (++requests===1) process.stdout.write('{"version":1,"id":1,"sizes":[1]}\\n');
      else setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'native'),100);
    });`
    );
    const writer = new RustObjectImporter(process.execPath, { objectsDirectory: directory }, 1000, [script]);
    t.after(() => writer.dispose());
    assert.deepEqual(await writer.persistMetadata([item('Version', {})]), [1]);
    writer.timeoutMs = 30;
    assert.equal(await writer.persistMetadata([item('Version', {})]), undefined);
    assert.equal(await fs.readFile(marker, 'utf8'), 'native');
    await fs.writeFile(marker, 'canonical');
    assert.equal(await fs.readFile(marker, 'utf8'), 'canonical');
  }
);

test('singleton and parallel mutable writes produce identical bytes and recover after rejection', async (t) => {
  const single = await setup(t);
  const batch = await setup(t);
  const objects = ['Version', 'VersionHistory', 'LaneHistory'].map((type, index) =>
    item(type, { data: '🚀'.repeat(1000), updated: index }, index + 20)
  );
  const batchSizes = await batch.writer.persistMetadata(objects);
  for (const [index, object] of objects.entries()) {
    assert.deepEqual(await single.writer.persistMetadata([object]), [batchSizes[index]]);
    assert.deepEqual(
      await fs.readFile(filename(single.directory, object)),
      await fs.readFile(filename(batch.directory, object))
    );
  }
  const invalid = item('Source', {}, 30);
  assert.deepEqual(await single.writer.persistMetadata([invalid]), [null]);
  const replacement = item('Version', { replacement: true }, 20);
  assert.ok((await single.writer.persistMetadata([replacement]))[0]);
  assert.deepEqual(zlib.inflateSync(await fs.readFile(filename(single.directory, replacement))), replacement.buffer);
  assert.equal(single.writer.unavailableReason, undefined);
});
