const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { readProgressiveTarBatches, TarTimeoutError } = require('./tar-batch-client.cjs');
const native =
  process.env.BIT_TEST_OBJECT_IMPORT ||
  path.resolve(__dirname, '../../native/target/debug/bit-object-import' + (process.platform === 'win32' ? '.exe' : ''));
function entry(name, body) {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write(body.length.toString(8).padStart(11, '0'), 124);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.fill(32, 148, 156);
  header.write(
    header
      .reduce((sum, byte) => sum + byte, 0)
      .toString(8)
      .padStart(6, '0') + '\0 ',
    148
  );
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}
function source(index) {
  const bytes = Buffer.concat([Buffer.from(`progressive Source ${index} 日本語 🚀`), Buffer.from([0, 255])]);
  const hash = crypto.createHash('sha1').update(bytes).digest('hex');
  const body = zlib.deflateSync(Buffer.concat([Buffer.from(`Source ${hash} ${bytes.toString().length}\0`), bytes]));
  return { hash, body, entry: entry(`scope/${hash}`, body) };
}
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bit progressive λ '));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const archive = path.join(directory, 'input.tar');
  await fs.writeFile(archive, Buffer.alloc(0), { mode: 0o600 });
  return { directory, archive, objectsDirectory: path.join(directory, 'objects') };
}
const filename = (directory, hash) => path.join(directory, hash.slice(0, 2), hash.slice(2));
function aborted(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
test('real helper persists a bounded Source batch while the append-only producer has not finished', async (t) => {
  const state = await fixture(t);
  const values = Array.from({ length: 33 }, (_, index) => source(index));
  const prefix = Buffer.concat(values.slice(0, 16).map((value) => value.entry));
  const suffix = Buffer.concat([...values.slice(16).map((value) => value.entry), Buffer.alloc(1024)]);
  let release,
    producerFinished = false,
    checked = false;
  const committed = new Promise((resolve) => {
    release = resolve;
  });
  const result = await readProgressiveTarBatches(
    native,
    state.archive,
    { objectsDirectory: state.objectsDirectory },
    async function* (signal) {
      await fs.appendFile(state.archive, prefix);
      yield { bytes: prefix.length };
      await Promise.race([committed, aborted(signal)]);
      assert.equal(checked, true);
      await fs.appendFile(state.archive, suffix);
      yield { bytes: prefix.length + suffix.length };
      producerFinished = true;
    },
    async (files) => ({
      selected: files.map((_, index) => index),
      settle: async (persisted) => {
        if (checked) return;
        assert.equal(producerFinished, false);
        assert.equal(files.length, 16);
        assert.equal(persisted.size, 16);
        for (const value of values.slice(0, 16))
          assert.deepEqual(await fs.readFile(filename(state.objectsDirectory, value.hash)), value.body);
        checked = true;
        release();
      },
    })
  );
  assert.deepEqual(result, { count: 33, persisted: 33, batches: 3 });
  assert.equal(producerFinished, true);
  for (const value of values)
    assert.deepEqual(await fs.readFile(filename(state.objectsDirectory, value.hash)), value.body);
});
test('progressive metadata preserves exact Unicode and offsets across header/body fragments', async (t) => {
  const state = await fixture(t);
  const hash = 'a'.repeat(40);
  const text = `Version ${hash} 0\0{"unicode":"日本語 🚀"}`;
  const body = zlib.deflateSync(Buffer.from(text));
  const bytes = entry(`scope/${hash}`, body);
  let offset = 0,
    consumed = 0;
  await readProgressiveTarBatches(
    native,
    state.archive,
    { metadata: true, digest: true },
    async function* () {
      for (const length of [1, 511, 512, 512 + body.length, bytes.length]) {
        await fs.appendFile(state.archive, bytes.subarray(offset, length));
        offset = length;
        yield { bytes: offset };
      }
    },
    async (files) => {
      consumed++;
      assert.equal(files.length, 1);
      assert.equal(files[0].offset, 512);
      assert.equal(files[0].size, body.length);
      assert.equal(files[0].sha1, crypto.createHash('sha1').update(body).digest('hex'));
      assert.equal(files[0].validation.metadata, text);
      return { selected: [] };
    }
  );
  assert.equal(consumed, 1);
});
test('producer failure preserves error identity and the acknowledged Source prefix', async (t) => {
  const state = await fixture(t);
  const values = Array.from({ length: 16 }, (_, index) => source(index));
  const prefix = Buffer.concat(values.map((value) => value.entry));
  const expected = new Error('original transfer failure');
  let release;
  const committed = new Promise((resolve) => {
    release = resolve;
  });
  await assert.rejects(
    readProgressiveTarBatches(
      native,
      state.archive,
      { objectsDirectory: state.objectsDirectory },
      async function* (signal) {
        await fs.appendFile(state.archive, prefix);
        yield { bytes: prefix.length };
        await Promise.race([committed, aborted(signal)]);
        throw expected;
      },
      async (files) => ({ selected: files.map((_, index) => index), settle: async () => release() })
    ),
    (error) => error === expected
  );
  for (const value of values)
    assert.deepEqual(await fs.readFile(filename(state.objectsDirectory, value.hash)), value.body);
});
test('timeout aborts a waiting producer and waits for its cleanup', async (t) => {
  const state = await fixture(t);
  let cleaned = false,
    consumed = false;
  await assert.rejects(
    readProgressiveTarBatches(
      native,
      state.archive,
      { timeoutMs: 50 },
      async function* (signal) {
        try {
          yield { bytes: 0 };
          await aborted(signal);
        } finally {
          cleaned = true;
        }
      },
      async () => {
        consumed = true;
        return {};
      }
    ),
    TarTimeoutError
  );
  assert.equal(cleaned, true);
  assert.equal(consumed, false);
});
test('host policy errors commit only the selected prefix and stop the producer', async (t) => {
  const state = await fixture(t);
  const values = Array.from({ length: 16 }, (_, index) => source(index));
  const prefix = Buffer.concat(values.map((value) => value.entry));
  const expected = new Error('canonical metadata policy failed');
  let cleaned = false,
    settled = 0;
  await assert.rejects(
    readProgressiveTarBatches(
      native,
      state.archive,
      { objectsDirectory: state.objectsDirectory },
      async function* (signal) {
        try {
          await fs.appendFile(state.archive, prefix);
          yield { bytes: prefix.length };
          await aborted(signal);
        } finally {
          cleaned = true;
        }
      },
      async () => ({
        selected: [0],
        error: expected,
        settle: async (persisted) => {
          settled++;
          assert.deepEqual([...persisted], [0]);
        },
      })
    ),
    (error) => error === expected
  );
  assert.equal(cleaned, true);
  assert.equal(settled, 1);
  assert.deepEqual(await fs.readFile(filename(state.objectsDirectory, values[0].hash)), values[0].body);
  for (const value of values.slice(1))
    await assert.rejects(fs.stat(filename(state.objectsDirectory, value.hash)), { code: 'ENOENT' });
});
test('declared EOF excludes hidden suffix bytes and preserves a complete Source before missing padding', async (t) => {
  const state = await fixture(t);
  const first = source(0),
    second = source(1);
  await fs.writeFile(state.archive, Buffer.concat([first.entry, second.entry]));
  await assert.rejects(
    readProgressiveTarBatches(
      native,
      state.archive,
      { objectsDirectory: state.objectsDirectory },
      async function* () {
        yield { bytes: 512 + first.body.length };
      },
      async () => ({ selected: [0] })
    ),
    { message: 'Unexpected end of data' }
  );
  assert.deepEqual(await fs.readFile(filename(state.objectsDirectory, first.hash)), first.body);
  await assert.rejects(fs.stat(filename(state.objectsDirectory, second.hash)), { code: 'ENOENT' });
});
test('cancellation waits for both active selection and producer cleanup without writing Sources', async (t) => {
  const state = await fixture(t);
  const values = Array.from({ length: 16 }, (_, index) => source(index));
  const prefix = Buffer.concat(values.map((value) => value.entry));
  const control = new AbortController();
  const expected = new Error('cancel active progressive selection');
  let producerCleaned = false,
    selectionCleaned = false,
    settled = false;
  await assert.rejects(
    readProgressiveTarBatches(
      native,
      state.archive,
      { objectsDirectory: state.objectsDirectory, signal: control.signal, awaitSelection: true },
      async function* (signal) {
        try {
          await fs.appendFile(state.archive, prefix);
          yield { bytes: prefix.length };
          await aborted(signal);
        } finally {
          producerCleaned = true;
        }
      },
      async (_, signal) => {
        control.abort(expected);
        await aborted(signal).catch(() => undefined);
        selectionCleaned = true;
        return {
          selected: [0],
          settle: async (persisted, repair) => {
            assert.equal(persisted, undefined);
            assert.equal(repair, false);
            settled = true;
          },
        };
      }
    ),
    (error) => error === expected
  );
  assert.equal(producerCleaned && selectionCleaned && settled, true);
  for (const value of values)
    await assert.rejects(fs.stat(filename(state.objectsDirectory, value.hash)), { code: 'ENOENT' });
});
test('invalid local progress is rejected before unannounced bytes reach policy', async (t) => {
  const state = await fixture(t);
  for (const invalid of [-1, 0.5, NaN, 2 * 1024 ** 3 + 1]) {
    let consumed = false;
    await assert.rejects(
      readProgressiveTarBatches(
        native,
        state.archive,
        {},
        async function* () {
          yield { bytes: invalid };
        },
        async () => {
          consumed = true;
          return {};
        }
      ),
      assert.AssertionError
    );
    assert.equal(consumed, false);
  }
});
