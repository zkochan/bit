const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { root, source } = require('./load-source.cjs');
const { RustObjectImporter } = source('components/legacy/scope/objects-fetcher/rust-object-importer.ts');
const native =
  process.env.BIT_TEST_OBJECT_IMPORT ||
  path.join(root, 'native/target/debug/bit-object-import' + (process.platform === 'win32' ? '.exe' : ''));
function object(value) {
  const contents = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const hash = crypto.createHash('sha1').update(contents).digest('hex');
  return {
    ref: { toString: () => hash },
    buffer: zlib.deflateSync(Buffer.concat([Buffer.from(`Source ${hash} ${contents.toString().length}\0`), contents])),
  };
}
async function importer(t, executable = native, timeout = 10000, args = []) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-native-store-test-'));
  const value = new RustObjectImporter(executable, { objectsDirectory: directory }, timeout, args);
  t.after(async () => {
    value.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { value, directory };
}
const filename = (directory, item) =>
  path.join(directory, item.ref.toString().slice(0, 2), item.ref.toString().slice(2));

test('native batch commits selected empty, Unicode, binary and large Sources without Node writes', async (t) => {
  const { value, directory } = await importer(t);
  const items = ['', '🚀 日本語', Buffer.from([0, 255, 254]), Buffer.alloc(4 * 1024 * 1024, 97)].map(object);
  let acknowledgements;
  await value.importBatch(
    items,
    async (validations) => {
      assert.ok(validations.every(Boolean));
      return [0, 2, 3];
    },
    async (selected, persisted) => {
      acknowledgements = persisted;
      assert.deepEqual(selected, [0, 2, 3]);
    }
  );
  assert.deepEqual([...acknowledgements], [0, 2, 3]);
  for (const index of acknowledgements)
    assert.deepEqual(await fs.readFile(filename(directory, items[index])), items[index].buffer);
  await assert.rejects(fs.access(filename(directory, items[1])), { code: 'ENOENT' });
  assert.equal(value.stats.persisted, 3);
});

test('empty selection writes nothing and releases the batch before the next request', async (t) => {
  const { value, directory } = await importer(t);
  const item = object('unselected');
  await value.importBatch(
    [item],
    async () => [],
    async (_, persisted) => assert.equal(persisted.size, 0)
  );
  assert.deepEqual(await fs.readdir(directory), []);
  await value.importBatch(
    [item],
    async () => [0],
    async (_, persisted) => assert.deepEqual([...persisted], [0])
  );
  assert.equal(value.stats.batches, 2);
});

test('corrupt and mutable records stay in the canonical JavaScript path', async (t) => {
  const { value } = await importer(t);
  const item = object('source');
  const bad = { ...item, buffer: Buffer.from(item.buffer) };
  bad.buffer[bad.buffer.length - 1] ^= 1;
  const mutable = { ...item, buffer: zlib.deflateSync(Buffer.from(`Version ${item.ref} 2\0{}`)) };
  await value.importBatch(
    [item, bad, mutable],
    async (values) => {
      assert.ok(values[0]);
      assert.equal(values[1], undefined);
      assert.equal(values[2], undefined);
      return [0];
    },
    async (_, persisted) => assert.deepEqual([...persisted], [0])
  );
  assert.equal(value.stats.legacy, 2);
});

test('native write failures are acknowledged for JavaScript retry', async (t) => {
  const { value, directory } = await importer(t);
  const item = object('retry');
  await fs.mkdir(filename(directory, item), { recursive: true });
  await value.importBatch(
    [item],
    async () => [0],
    async (_, persisted) => assert.equal(persisted.size, 0)
  );
  assert.equal(value.stats.writeFallbacks, 1);
  assert.equal((await fs.readdir(path.dirname(filename(directory, item)))).length, 1);
});

for (const mode of ['crash', 'wrong-validation', 'wrong-commit', 'partial-commit', 'hung', 'crash-commit']) {
  test(`${mode} falls back for the whole affected phase and clears queued work`, async (t) => {
    const { value } = await importer(t, process.execPath, 150, [path.join(__dirname, 'fake-importer.cjs'), mode]);
    const item = object('fallback');
    let finishes = 0;
    const run = () =>
      value.importBatch(
        [item],
        async (values) => (values[0] ? [0] : []),
        async (_, persisted) => {
          assert.equal(persisted, undefined);
          finishes++;
        }
      );
    await Promise.all([run(), run()]);
    assert.equal(finishes, 2);
    assert.ok(value.unavailableReason);
    assert.equal(value.bytes, 0);
  });
}

test('missing helper, bounds and disposal preserve the JavaScript path', async (t) => {
  const { value } = await importer(t, path.join(root, 'missing-store-helper'));
  const item = object('fallback');
  await value.importBatch(
    [item],
    async (values) => {
      assert.deepEqual(values, [undefined]);
      return [];
    },
    async (_, persisted) => assert.equal(persisted, undefined)
  );
  const { value: bounded } = await importer(t);
  await bounded.importBatch(
    Array(17).fill(item),
    async (values) => {
      assert.ok(values.every((x) => x === undefined));
      return [];
    },
    async () => {}
  );
  assert.equal(bounded.child, undefined);
  const pending = bounded.importBatch(
    [item],
    async () => [],
    async () => {}
  );
  bounded.dispose();
  await pending;
});

test('selection errors propagate unchanged, abort the held batch, and permit fallback afterwards', async (t) => {
  const { value, directory } = await importer(t);
  const error = new Error('canonical merge failure');
  await assert.rejects(
    value.importBatch(
      [object('error')],
      async () => {
        throw error;
      },
      async () => {}
    ),
    (actual) => actual === error
  );
  assert.deepEqual(await fs.readdir(directory), []);
  await value.importBatch(
    [object('next')],
    async (values) => {
      assert.deepEqual(values, [undefined]);
      return [];
    },
    async () => {}
  );
});
