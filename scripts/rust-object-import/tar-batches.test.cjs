const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { readTarBatches } = require('./tar-batch-client.cjs');
const { processArchive } = require('./tar-batch-worker.cjs');
const native =
  process.env.BIT_TEST_OBJECT_IMPORT ||
  path.resolve(__dirname, '../../native/target/debug/bit-object-import' + (process.platform === 'win32' ? '.exe' : ''));
function entry(name, body = Buffer.alloc(0), flag = '0') {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write(body.length.toString(8).padStart(11, '0'), 124);
  header.write(flag, 156);
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
function source(value) {
  const bytes = Buffer.from(value);
  const hash = crypto.createHash('sha1').update(bytes).digest('hex');
  const body = zlib.deflateSync(Buffer.concat([Buffer.from(`Source ${hash} ${bytes.toString().length}\0`), bytes]));
  return { hash, body, entry: entry(`scope/${hash}`, body) };
}
async function fixture(t, bytes) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bit tar batches λ '));
  const archive = path.join(directory, 'archive.tar');
  await fs.writeFile(archive, bytes);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { archive, directory, objectsDirectory: path.join(directory, 'objects') };
}
const filename = (directory, hash) => path.join(directory, hash.slice(0, 2), hash.slice(2));
test('staged batches validate Sources and retain exact offsets without writing before selection', async (t) => {
  const items = ['', '🚀 日本語', Buffer.from([0, 255]), Buffer.alloc(1024 * 1024, 97)].map(source);
  const { archive, objectsDirectory } = await fixture(t, Buffer.concat(items.map((item) => item.entry)));
  const handle = await fs.open(archive);

  let stats;
  try {
    stats = await readTarBatches(native, archive, { objectsDirectory, digest: true }, async (files) => {
      await assert.rejects(fs.stat(objectsDirectory), { code: 'ENOENT' });
      for (const [index, file] of files.entries()) {
        assert.equal(file.validation.status, 'source');
        assert.equal(file.validation.hash, items[index].hash);
        const buffer = Buffer.alloc(file.size);
        assert.equal((await handle.read(buffer, 0, buffer.length, file.offset)).bytesRead, buffer.length);
        assert.deepEqual(buffer, items[index].body);
        assert.equal(file.sha1, crypto.createHash('sha1').update(buffer).digest('hex'));
      }
      return { selected: [0, 2, 3] };
    });
  } finally {
    await handle.close();
  }
  assert.equal(stats.persisted, 3);
  for (const index of [0, 2, 3])
    assert.deepEqual(await fs.readFile(filename(objectsDirectory, items[index].hash)), items[index].body);
  await assert.rejects(fs.stat(filename(objectsDirectory, items[1].hash)), { code: 'ENOENT' });
});
test('large entry counts preserve batch order and require every acknowledgement', async (t) => {
  const bytes = Buffer.concat(
    Array.from({ length: 70 }, (_, index) => entry(`scope/name${index}`, Buffer.from(String(index))))
  );
  const { archive } = await fixture(t, bytes);
  const names = [];
  const stats = await readTarBatches(native, archive, {}, async (files) => {
    assert.ok(files.length <= 16);
    names.push(...files.map((file) => file.name));
    return { selected: [] };
  });
  assert.equal(stats.batches, 5);
  assert.deepEqual(
    names,
    Array.from({ length: 70 }, (_, index) => `scope/name${index}`)
  );
});
test('ordered host errors commit only preceding Sources and reap the helper before returning', async (t) => {
  const before = source('before'),
    after = source('after');
  const { archive, objectsDirectory } = await fixture(t, Buffer.concat([before.entry, entry('scope/'), after.entry]));
  await assert.rejects(processArchive(archive, 'store', objectsDirectory), {
    message: 'failed creating a Ref object, the hash argument is empty',
  });
  assert.deepEqual(await fs.readFile(filename(objectsDirectory, before.hash)), before.body);
  await assert.rejects(fs.stat(filename(objectsDirectory, after.hash)), { code: 'ENOENT' });
});
test('remote errors stop before subsequent Source commits', async (t) => {
  const before = source('before'),
    after = source('after');
  const { archive, objectsDirectory } = await fixture(
    t,
    Buffer.concat([before.entry, entry('.BIT.ERROR', Buffer.from('remote failed: 日本語')), after.entry])
  );
  await assert.rejects(processArchive(archive, 'store', objectsDirectory), { message: 'remote failed: 日本語' });
  assert.deepEqual(await fs.readFile(filename(objectsDirectory, before.hash)), before.body);
  await assert.rejects(fs.stat(filename(objectsDirectory, after.hash)), { code: 'ENOENT' });
});
test('missing or falsy END never acknowledges a complete import', async (t) => {
  const start = entry('.BIT.START', Buffer.from('{"schema":"1.0.0","scopeName":"scope"}'));
  for (const ending of [
    Buffer.alloc(0),
    entry('.BIT.END', Buffer.from('null')),
    entry('.BIT.END', Buffer.from('false')),
  ]) {
    const { archive, objectsDirectory } = await fixture(t, Buffer.concat([start, source('source').entry, ending]));
    await assert.rejects(processArchive(archive, 'store', objectsDirectory), {
      message: 'server terminated the stream unexpectedly (metadata: {"schema":"1.0.0","scopeName":"scope"})',
    });
  }
});
test('complete bodies precede padding errors while partial bodies do not emit records', async (t) => {
  const bytes = entry('scope/object', Buffer.from('complete'));
  for (const [length, count] of [
    [515, 0],
    [520, 1],
  ]) {
    const { archive } = await fixture(t, bytes.subarray(0, length));
    let seen = 0;
    await assert.rejects(
      readTarBatches(native, archive, {}, async (files) => {
        seen += files.length;
        return { selected: [] };
      }),
      { message: 'Unexpected end of data' }
    );
    assert.equal(seen, count);
  }
});
test('oversized extension headers fall back before allocating the advertised body', async (t) => {
  const bytes = entry('extended', Buffer.alloc(65537), 'x');
  const { archive } = await fixture(t, bytes.subarray(0, 512));
  await assert.rejects(
    readTarBatches(native, archive, {}, async () => {
      assert.fail('no entry expected');
    }),
    { message: 'native tar fallback required' }
  );
});
test('host selection failure and timeout write no Sources', async (t) => {
  const { archive, objectsDirectory } = await fixture(t, source('source').entry);
  await assert.rejects(
    readTarBatches(native, archive, { objectsDirectory }, async () => {
      throw new Error('policy failed');
    }),
    { message: 'policy failed' }
  );
  let entered = false;
  await assert.rejects(
    readTarBatches(native, archive, { objectsDirectory, timeoutMs: 1000 }, async () => {
      entered = true;
      return new Promise(() => {});
    }),
    { message: 'tar operation timed out' }
  );
  assert.equal(entered, true);
  await assert.rejects(fs.stat(objectsDirectory), { code: 'ENOENT' });
});
test('failed persistence reports failure without completing the operation or leaving temporary files', async (t) => {
  const item = source('source');
  const { archive, objectsDirectory } = await fixture(t, item.entry);
  await fs.mkdir(filename(objectsDirectory, item.hash), { recursive: true });
  await assert.rejects(
    readTarBatches(native, archive, { objectsDirectory }, async () => ({ selected: [0] })),
    { message: 'native tar Source persistence failed' }
  );
  assert.deepEqual(await fs.readdir(path.join(objectsDirectory, item.hash.slice(0, 2))), [item.hash.slice(2)]);
});
test('acknowledgement settles once before reporting an ordered host error', async (t) => {
  const value = source('prefix before policy error');
  const { archive, objectsDirectory } = await fixture(t, value.entry);
  let settled = 0;
  await assert.rejects(
    readTarBatches(native, archive, { objectsDirectory }, async () => ({
      selected: [0],
      error: new Error('later policy failure'),
      settle: async (persisted) => {
        settled++;
        assert.deepEqual([...persisted], [0]);
        assert.deepEqual(await fs.readFile(filename(objectsDirectory, value.hash)), value.body);
      },
    })),
    { message: 'later policy failure' }
  );
  assert.equal(settled, 1);
});
test('failed writes settle their acknowledged subset before propagating failure', async (t) => {
  const values = ['written', 'blocked'].map(source);
  const { archive, objectsDirectory } = await fixture(t, Buffer.concat(values.map((value) => value.entry)));
  await fs.mkdir(filename(objectsDirectory, values[1].hash), { recursive: true });
  let settled = 0;
  await assert.rejects(
    readTarBatches(native, archive, { objectsDirectory }, async () => ({
      selected: [0, 1],
      settle: async (persisted, repair) => {
        settled++;
        assert.equal(repair, true);
        assert.deepEqual([...persisted], [0]);
        await fs.rm(filename(objectsDirectory, values[1].hash), { recursive: true });
        await fs.writeFile(filename(objectsDirectory, values[1].hash), values[1].body);
      },
    })),
    { message: 'native tar Source persistence failed' }
  );
  assert.equal(settled, 1);
  for (const value of values) assert.deepEqual(await fs.readFile(filename(objectsDirectory, value.hash)), value.body);
});
test('cooperative cancellation waits for selection cleanup and disables Source repairs', async (t) => {
  const { archive, objectsDirectory } = await fixture(t, source('cancel selection').entry);
  const control = new AbortController();
  let cleaned = false,
    settled = 0;
  await assert.rejects(
    readTarBatches(
      native,
      archive,
      {
        objectsDirectory,
        signal: control.signal,
        awaitSelection: true,
      },
      async (_files, signal) => {
        control.abort(new Error('cancel repository operation'));
        assert.equal(signal.aborted, true);
        await new Promise((resolve) => setTimeout(resolve, 30));
        cleaned = true;
        return {
          selected: [],
          settle: async (persisted, repair) => {
            settled++;
            assert.equal(cleaned, true);
            assert.equal(persisted, undefined);
            assert.equal(repair, false);
          },
        };
      }
    ),
    { message: 'cancel repository operation' }
  );
  assert.equal(cleaned, true);
  assert.equal(settled, 1);
  await assert.rejects(fs.stat(objectsDirectory), { code: 'ENOENT' });
});
test('a failing settlement is never retried', async (t) => {
  const { archive } = await fixture(t, source('settlement failure').entry);
  let settled = 0;
  await assert.rejects(
    readTarBatches(native, archive, {}, async () => ({
      selected: [],
      settle: async () => {
        settled++;
        throw new Error('repair failed');
      },
    })),
    { message: 'repair failed' }
  );
  assert.equal(settled, 1);
});
test('native metadata is opt-in, lossless and bounded with canonical fallback descriptors', async (t) => {
  const hash = 'a'.repeat(40);
  const text = `Version ${hash} 0\0{"unicode":"日本語 🚀","invalid":`;
  const body = zlib.deflateSync(Buffer.from(text));
  const truncated = body.subarray(0, body.length - 1);
  const invalidUtf8 = zlib.deflateSync(Buffer.concat([Buffer.from(`Version ${hash} 0\0`), Buffer.from([255])]));
  const oversized = zlib.deflateSync(Buffer.from(`Version ${hash} 0\0` + 'a'.repeat(256 * 1024)));
  const badSource = source('invalid Source identity');
  const bodies = [body, truncated, invalidUtf8, oversized, badSource.body];
  const { archive } = await fixture(t, Buffer.concat(bodies.map((bytes) => entry(`scope/${hash}`, bytes))));
  for (const metadata of [false, true]) {
    await readTarBatches(native, archive, { metadata }, async (files) => {
      assert.equal(files[0].validation.status, metadata ? 'metadata' : 'legacy');
      assert.equal(files[0].validation.metadata, metadata ? text : undefined);
      if (metadata) assert.equal(files[0].validation.inflatedBytes, Buffer.byteLength(text));
      for (const file of files.slice(1)) {
        assert.equal(file.validation.status, 'legacy');
        assert.equal(file.validation.metadata, undefined);
      }
      return { selected: [] };
    });
  }
});
test(
  'invalid or unsolicited helper metadata is rejected before repository policy',
  { skip: process.platform === 'win32' },
  async (t) => {
    const hash = 'a'.repeat(40);
    const text = `Version ${hash} 2\0{}`;
    const { archive, directory } = await fixture(t, entry(`scope/${hash}`, zlib.deflateSync(Buffer.from(text))));
    const valid = { hash, status: 'metadata', reason: null, inflatedBytes: Buffer.byteLength(text), metadata: text };
    const cases = [
      [false, valid],
      [true, { ...valid, inflatedBytes: text.length + 1 }],
      [true, { ...valid, metadata: 1 }],
      [true, { ...valid, metadata: 'a'.repeat(256 * 1024 + 1), inflatedBytes: 256 * 1024 + 1 }],
      [true, { ...valid, status: 'source' }],
      [true, { ...valid, metadata: 'Source ' + hash + ' 0\0', inflatedBytes: 50 }],
      [true, { ...valid, metadata: 'no header separator', inflatedBytes: 19 }],
      [true, { ...valid, metadata: 'Version ' + hash + ' 0\0\ud800', inflatedBytes: 54 }],
      [true, { ...valid, status: 'legacy', inflatedBytes: 0, reason: 'unsupported' }],
      [
        true,
        { ...valid, metadata: text + 'a'.repeat(256 * 1024 - Buffer.byteLength(text)), inflatedBytes: 256 * 1024 },
        3,
      ],
    ];
    for (const [index, [metadata, validation, count = 1]] of cases.entries()) {
      const executable = path.join(directory, `invalid-helper-${index}`);
      const response = {
        version: 1,
        id: 1,
        sequence: 0,
        done: false,
        fallback: false,
        error: null,
        files: Array.from({ length: count }, () => ({
          name: `scope/${hash}`,
          offset: 512,
          size: 1,
          sha1: null,
          text: null,
          validation,
        })),
      };
      await fs.writeFile(
        executable,
        '#!/usr/bin/env node\nprocess.stdin.once("data",()=>process.stdout.write(' +
          JSON.stringify(JSON.stringify(response) + '\n') +
          '));process.stdin.resume();',
        { mode: 0o700 }
      );
      let consumed = false;
      await assert.rejects(
        readTarBatches(executable, archive, { metadata }, async () => {
          consumed = true;
          return {};
        })
      );
      assert.equal(consumed, false);
    }
  }
);
