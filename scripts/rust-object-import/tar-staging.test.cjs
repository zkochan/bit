const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable, PassThrough } = require('node:stream');
const http = require('node:http');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { once } = require('node:events');
const { withStagedArchive } = require('./tar-staging.cjs');
const { openLoopbackArchive } = require('./tar-loopback.cjs');
const { processArchive } = require('./tar-batch-worker.cjs');
const native =
  process.env.BIT_TEST_OBJECT_IMPORT ||
  path.resolve(__dirname, '../../native/target/debug/bit-object-import' + (process.platform === 'win32' ? '.exe' : ''));
const { readTarBatches } = require('./tar-batch-client.cjs');
function entry(name, body = Buffer.alloc(0)) {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write(body.length.toString(8).padStart(11, '0'), 124);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.fill(32, 148, 156);
  header.write(
    header
      .reduce((sum, value) => sum + value, 0)
      .toString(8)
      .padStart(6, '0') + '\0 ',
    148
  );
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}
async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bit tar staging λ '));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 }));
  return root;
}
async function server(t, handler) {
  const service = http.createServer(handler);
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  t.after(
    () =>
      new Promise((resolve) => {
        service.closeAllConnections();
        service.close(resolve);
      })
  );
  return `http://127.0.0.1:${service.address().port}`;
}
function response(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, resolve);
    request.on('error', reject);
  });
}
test('owned staging preserves binary bytes and releases the private file only after consumption', async (t) => {
  const root = await directory(t);
  const bytes = Buffer.from([0, 255, 254, 13, 10]);
  let staged;
  const value = await withStagedArchive(
    Readable.from([bytes.subarray(0, 2), bytes.subarray(2)]),
    { directory: root, maxBytes: bytes.length },
    async ({ archive, bytes: size, signal }) => {
      staged = archive;
      assert.equal(size, bytes.length);
      assert.equal(signal.aborted, false);
      assert.deepEqual(await fs.readFile(archive), bytes);
      if (process.platform !== 'win32') {
        assert.equal((await fs.stat(path.dirname(archive))).mode & 0o777, 0o700);
        assert.equal((await fs.stat(archive)).mode & 0o777, 0o600);
      }
      return 42;
    }
  );
  assert.equal(value, 42);
  await assert.rejects(fs.stat(staged), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(root), []);
});
test('oversized input, input errors and consumer failures never retain a staging directory', async (t) => {
  const root = await directory(t);
  await assert.rejects(
    withStagedArchive(Readable.from([Buffer.alloc(9)]), { directory: root, maxBytes: 8 }, () =>
      assert.fail('oversized callback')
    ),
    /byte limit exceeded/
  );
  const input = new PassThrough();
  const failed = withStagedArchive(input, { directory: root }, () => assert.fail('failed input callback'));
  input.destroy(new Error('transport failed'));
  await assert.rejects(failed, /transport failed/);
  await assert.rejects(
    withStagedArchive(Readable.from([Buffer.from('data')]), { directory: root }, () => {
      throw new Error('consumer failed');
    }),
    /consumer failed/
  );
  assert.deepEqual(await fs.readdir(root), []);
});
test('operation deadline aborts a stalled input and cleans its partial file', async (t) => {
  const root = await directory(t);
  const input = new PassThrough();
  input.write(Buffer.from('partial'));
  await assert.rejects(
    withStagedArchive(input, { directory: root, timeoutMs: 50 }, () => assert.fail('incomplete callback')),
    /staging timed out/
  );
  assert.equal(input.destroyed, true);
  assert.deepEqual(await fs.readdir(root), []);
});
test('external cancellation also reaps a helper while host selection is stalled before deleting the archive', async (t) => {
  const root = await directory(t);
  const controller = new AbortController();
  let staged;
  await assert.rejects(
    withStagedArchive(
      Readable.from([entry('unknown')]),
      { directory: root, signal: controller.signal },
      async ({ archive, signal }) => {
        staged = archive;
        return readTarBatches(native, archive, { signal }, async () => {
          assert.ok((await fs.stat(archive)).isFile());
          controller.abort(new Error('caller cancelled'));
          return new Promise(() => {});
        });
      }
    ),
    /caller cancelled/
  );
  await assert.rejects(fs.stat(staged), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(root), []);
});
test('active stages and waiting admissions are bounded, and a cancelled waiter never consumes input', async (t) => {
  const root = await directory(t);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  let entered = 0;
  let ready;
  const full = new Promise((resolve) => {
    ready = resolve;
  });
  const active = Array.from({ length: 4 }, () =>
    withStagedArchive(Readable.from([]), { directory: root }, async () => {
      if (++entered === 4) ready();
      await held;
    })
  );
  await full;
  const controller = new AbortController();
  const input = new PassThrough();
  const cancelled = withStagedArchive(input, { directory: root, signal: controller.signal }, () =>
    assert.fail('cancelled waiter admitted')
  );
  controller.abort(new Error('queued cancellation'));
  await assert.rejects(cancelled, /queued cancellation/);
  assert.equal(input.destroyed, true);
  const waiting = Array.from({ length: 16 }, () => withStagedArchive(Readable.from([]), { directory: root }, () => {}));
  await assert.rejects(
    withStagedArchive(Readable.from([]), { directory: root }, () => assert.fail('queue overflow admitted')),
    /queue full/
  );
  release();
  await Promise.all([...active, ...waiting]);
  assert.deepEqual(await fs.readdir(root), []);
});
test('staging rejects repository directories before consuming the input', async (t) => {
  const root = await directory(t);
  await fs.mkdir(path.join(root, '.git'));
  const input = new PassThrough();
  await assert.rejects(
    withStagedArchive(input, { directory: root }, () => assert.fail('repository callback')),
    /outside Git/
  );
  assert.equal(input.destroyed, true);
});
test('real HTTP response streams stage with backpressure and reject aborted transfers before native processing', async (t) => {
  const root = await directory(t);
  const bytes = Buffer.alloc(1024 * 1024, 71);
  let backpressure = false;
  const url = await server(t, async (request, result) => {
    if (request.url === '/abort') {
      result.writeHead(200, { 'Content-Length': 1000 });
      result.write(Buffer.from('partial'));
      setTimeout(() => result.destroy(), 10);
      return;
    }
    for (let offset = 0; offset < bytes.length; offset += 4096) {
      if (!result.write(bytes.subarray(offset, offset + 4096))) {
        backpressure = true;
        await once(result, 'drain');
      }
    }
    result.end();
  });
  await withStagedArchive(await response(url), { directory: root }, async ({ archive }) =>
    assert.deepEqual(await fs.readFile(archive), bytes)
  );
  assert.equal(backpressure, true);
  await assert.rejects(
    withStagedArchive(await response(url + '/abort'), { directory: root }, () =>
      assert.fail('aborted native processing')
    ),
    /aborted|reset|closed/
  );
  assert.deepEqual(await fs.readdir(root), []);
});
test('native marker failure on a completely staged HTTP archive cleans the file after partial Source writes', async (t) => {
  const root = await directory(t);
  // Build a schema-1 START without END; native framing succeeds but host completion must fail.
  const body = Buffer.from('{"schema":"1.0.0","scopeName":"http"}');
  const contents = Buffer.from('HTTP prefix source');
  const hash = crypto.createHash('sha1').update(contents).digest('hex');
  const compressed = zlib.deflateSync(Buffer.concat([Buffer.from(`Source ${hash} ${contents.length}\0`), contents]));
  const bytes = Buffer.concat([entry('.BIT.START', body), entry(`http/${hash}`, compressed), Buffer.alloc(1024)]);
  const url = await server(t, (_, result) => result.end(bytes));
  await assert.rejects(
    withStagedArchive(await response(url), { directory: root }, ({ archive, signal }) =>
      processArchive(archive, 'store', path.join(root, 'objects'), { signal })
    ),
    /server terminated the stream unexpectedly/
  );
  assert.deepEqual(await fs.readdir(root), ['objects']);
  assert.deepEqual(await fs.readFile(path.join(root, 'objects', hash.slice(0, 2), hash.slice(2))), compressed);
});

test('pre-aborted callers and cancellation during successful consumption cannot report completion', async (t) => {
  const root = await directory(t);
  const already = new AbortController();
  already.abort(new Error('already cancelled'));
  await assert.rejects(
    withStagedArchive(Readable.from([]), { directory: root, signal: already.signal }, () =>
      assert.fail('pre-aborted callback')
    ),
    /already cancelled/
  );
  const controller = new AbortController();
  await assert.rejects(
    withStagedArchive(Readable.from([]), { directory: root, signal: controller.signal }, () => {
      controller.abort(new Error('cancelled before return'));
      return { done: true };
    }),
    /cancelled before return/
  );
  assert.deepEqual(await fs.readdir(root), []);
});

test('authenticated fixture HTTP transfer completes native Source persistence and cleans its owned stage', async (t) => {
  const root = await directory(t);
  const contents = Buffer.alloc(64 * 1024, 97);
  const hash = crypto.createHash('sha1').update(contents).digest('hex');
  const compressed = zlib.deflateSync(Buffer.concat([Buffer.from(`Source ${hash} ${contents.length}\0`), contents]));
  const origin = path.join(root, 'origin.tar');
  await fs.writeFile(
    origin,
    Buffer.concat([
      entry('.BIT.START', Buffer.from('{"schema":"1.0.0","scopeName":"http"}')),
      entry(`http/${hash}`, compressed),
      entry('.BIT.END', Buffer.from('{"numOfFiles":1,"scopeName":"http"}')),
      Buffer.alloc(1024),
    ])
  );
  const transport = await openLoopbackArchive(origin);
  try {
    const result = await withStagedArchive(transport.stream, { directory: root }, ({ archive, signal }) =>
      processArchive(archive, 'store', path.join(root, 'objects'), { signal })
    );
    assert.equal(result.done, true);
    assert.equal(result.count, 1);
    assert.equal(result.sources, 1);
    assert.deepEqual(await fs.readFile(path.join(root, 'objects', hash.slice(0, 2), hash.slice(2))), compressed);
    assert.deepEqual((await fs.readdir(root)).sort(), ['objects', 'origin.tar']);
  } finally {
    await transport.close();
  }
});
