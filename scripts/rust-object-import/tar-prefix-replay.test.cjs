const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { Readable, PassThrough } = require('node:stream');
const { withStagedArchive } = require('./tar-staging.cjs');
async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bit tar prefix λ '));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 }));
  return root;
}
async function collect(input) {
  const chunks = [];
  for await (const chunk of input) chunks.push(chunk);
  return Buffer.concat(chunks);
}
test('byte-limit fallback replays persisted prefix, rejected chunk and original unread tail exactly once', async (t) => {
  const root = await directory(t);
  const chunks = [Buffer.from([0, 255]), Buffer.from([254, 10, 13]), Buffer.from('unread tail')];
  let pulls = 0;
  const input = Readable.from(
    (async function* () {
      for (const chunk of chunks) {
        pulls++;
        yield chunk;
      }
    })()
  );
  const value = await withStagedArchive(
    input,
    {
      directory: root,
      maxBytes: 4,
      replay: async (stream, { cause, signal }) => {
        assert.equal(cause.code, 'BIT_TAR_STAGE_LIMIT');
        assert.equal(signal.aborted, false);
        return collect(stream);
      },
    },
    () => assert.fail('oversized native consume')
  );
  assert.deepEqual(value, Buffer.concat(chunks));
  assert.equal(pulls, chunks.length);
  assert.deepEqual(await fs.readdir(root), []);
});
test('short staging writes followed by disk failure preserve the unwritten part without duplication', async (t) => {
  const root = await directory(t);
  const original = fs.open;
  let writes = 0;
  fs.open = async (...args) => {
    const handle = await original(...args);
    const write = handle.write.bind(handle);
    handle.write = async (buffer, offset, length, position) => {
      if (++writes === 2) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return write(buffer, offset, Math.min(length, 3), position);
    };
    return handle;
  };
  t.after(() => {
    fs.open = original;
  });
  const bytes = Buffer.from('exact full input');
  const result = await withStagedArchive(
    Readable.from([bytes]),
    {
      directory: root,
      replay: async (stream, { cause }) => {
        assert.equal(cause.code, 'ENOSPC');
        return collect(stream);
      },
    },
    () => assert.fail('failed disk consume')
  );
  assert.equal(writes, 2);
  assert.deepEqual(result, bytes);
  assert.deepEqual(await fs.readdir(root), []);
});
test('failure opening the stage replays the untouched original stream', async (t) => {
  const root = await directory(t);
  const original = fs.open;
  fs.open = async () => {
    throw Object.assign(new Error('cannot open stage'), { code: 'EACCES' });
  };
  t.after(() => {
    fs.open = original;
  });
  const bytes = Buffer.from('untouched');
  const result = await withStagedArchive(Readable.from([bytes]), { directory: root, replay: collect }, () =>
    assert.fail('unopened consume')
  );
  assert.deepEqual(result, bytes);
  assert.deepEqual(await fs.readdir(root), []);
});
test('transport failure replays the received prefix then raises the original error without native processing', async (t) => {
  const root = await directory(t);
  const cause = new Error('original transport error');
  let prefix = Buffer.alloc(0);
  const input = Readable.from(
    (async function* () {
      yield Buffer.from('complete entry prefix');
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw cause;
    })()
  );
  await assert.rejects(
    withStagedArchive(
      input,
      {
        directory: root,
        replay: async (stream, { cause: failure }) => {
          assert.equal(failure, cause);
          for await (const chunk of stream) prefix = Buffer.concat([prefix, chunk]);
        },
      },
      () => assert.fail('interrupted consume')
    ),
    (error) => error === cause
  );
  assert.equal(prefix.toString(), 'complete entry prefix');
  assert.deepEqual(await fs.readdir(root), []);
});
test('consumer failure never replays completed native or canonical policy work', async (t) => {
  const root = await directory(t);
  let processed = 0;
  await assert.rejects(
    withStagedArchive(
      Readable.from([Buffer.from('archive')]),
      { directory: root, replay: () => assert.fail('post-policy replay') },
      () => {
        processed++;
        throw new Error('policy failed after progress');
      }
    ),
    /policy failed after progress/
  );
  assert.equal(processed, 1);
  assert.deepEqual(await fs.readdir(root), []);
});
test('caller cancellation and deadline do not start replay', async (t) => {
  const root = await directory(t);
  const controller = new AbortController();
  const input = new PassThrough();
  const operation = withStagedArchive(
    input,
    { directory: root, signal: controller.signal, replay: () => assert.fail('cancelled replay') },
    () => assert.fail('cancelled consume')
  );
  controller.abort(new Error('cancelled'));
  await assert.rejects(operation, /cancelled/);
  await assert.rejects(
    withStagedArchive(
      new PassThrough(),
      { directory: root, timeoutMs: 30, replay: () => assert.fail('deadline replay') },
      () => assert.fail('stalled consume')
    ),
    /timed out/
  );
  assert.deepEqual(await fs.readdir(root), []);
});
test('cancellation while replaying an unread tail closes all readers before removing the stage', async (t) => {
  const root = await directory(t);
  const controller = new AbortController();
  const input = new PassThrough();
  input.write(Buffer.from('oversized'));
  await assert.rejects(
    withStagedArchive(
      input,
      {
        directory: root,
        maxBytes: 1,
        signal: controller.signal,
        replay: async (stream) => {
          for await (const chunk of stream) {
            assert.equal(chunk.toString(), 'oversized');
            controller.abort(new Error('replay cancelled'));
          }
        },
      },
      () => assert.fail('oversized consume')
    ),
    /replay cancelled/
  );
  assert.equal(input.destroyed, true);
  assert.deepEqual(await fs.readdir(root), []);
});
test('an incomplete replay callback cannot claim successful completion', async (t) => {
  const root = await directory(t);
  await assert.rejects(
    withStagedArchive(
      Readable.from([Buffer.from('oversized')]),
      { directory: root, maxBytes: 1, replay: () => ({ done: true }) },
      () => assert.fail('oversized consume')
    ),
    /replay must consume/
  );
  assert.deepEqual(await fs.readdir(root), []);
});
test('real aborted HTTP transfer preserves the received bytes and error through replay', async (t) => {
  const root = await directory(t);
  const bytes = Buffer.alloc(128 * 1024, 73);
  const server = http.createServer((_, response) => {
    response.writeHead(200, { 'Content-Length': bytes.length + 1 });
    response.write(bytes, () => setTimeout(() => response.destroy(), 20));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );
  const input = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${server.address().port}`, resolve).on('error', reject);
  });
  const received = [];
  await assert.rejects(
    withStagedArchive(
      input,
      {
        directory: root,
        replay: async (stream) => {
          for await (const chunk of stream) received.push(chunk);
        },
      },
      () => assert.fail('aborted HTTP consume')
    ),
    /aborted|reset|closed/
  );
  assert.deepEqual(Buffer.concat(received), bytes);
  assert.deepEqual(await fs.readdir(root), []);
});

test('transport errors retain bytes buffered behind an in-flight disk write', async (t) => {
  const root = await directory(t);
  const input = new PassThrough();
  const cause = new Error('transport failed during write');
  const original = fs.open;
  let injected = false;
  fs.open = async (...args) => {
    const handle = await original(...args);
    const write = handle.write.bind(handle);
    handle.write = async (...values) => {
      if (!injected) {
        injected = true;
        input.write(Buffer.from('buffered tail'));
        input.destroy(cause);
        await new Promise((resolve) => setImmediate(resolve));
      }
      return write(...values);
    };
    return handle;
  };
  t.after(() => {
    fs.open = original;
  });
  input.write(Buffer.from('first chunk'));
  const chunks = [];
  await assert.rejects(
    withStagedArchive(
      input,
      {
        directory: root,
        replay: async (stream) => {
          for await (const chunk of stream) chunks.push(chunk);
        },
      },
      () => assert.fail('failed transfer consume')
    ),
    (error) => error === cause
  );
  assert.equal(Buffer.concat(chunks).toString(), 'first chunkbuffered tail');
  assert.deepEqual(await fs.readdir(root), []);
});

test('a transport failure during queued admission replays its buffered prefix without occupying a stage', async (t) => {
  const root = await directory(t);
  let release,
    entered = 0,
    ready;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
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
  const input = new PassThrough();
  input.write(Buffer.from('queued prefix'));
  const cause = new Error('queued transport failed');
  const chunks = [];
  const operation = withStagedArchive(
    input,
    {
      directory: root,
      replay: async (stream) => {
        for await (const chunk of stream) chunks.push(chunk);
      },
    },
    () => assert.fail('failed queued consume')
  );
  input.destroy(cause);
  await assert.rejects(operation, (error) => error === cause);
  assert.equal(Buffer.concat(chunks).toString(), 'queued prefix');
  assert.equal((await fs.readdir(root)).length, 4);
  release();
  await Promise.all(active);
  assert.deepEqual(await fs.readdir(root), []);
});

test('premature close without an error event preserves prefix and canonical close error', async (t) => {
  const root = await directory(t);
  const input = new PassThrough();
  input.write(Buffer.from('close prefix'));
  const chunks = [];
  const operation = withStagedArchive(
    input,
    {
      directory: root,
      replay: async (stream) => {
        for await (const chunk of stream) chunks.push(chunk);
      },
    },
    () => assert.fail('premature close consume')
  );
  setTimeout(() => input.destroy(), 10);
  await assert.rejects(operation, { code: 'ERR_STREAM_PREMATURE_CLOSE' });
  assert.equal(Buffer.concat(chunks).toString(), 'close prefix');
  assert.deepEqual(await fs.readdir(root), []);
});
