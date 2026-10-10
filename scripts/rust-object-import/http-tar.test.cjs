const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const { once } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const { installed } = require('./load-source.cjs');
const { Repository, Source, Ref, VersionHistory } = installed('@teambit/objects');
const { Http } = installed('@teambit/scope.network/dist/http/http.js');
const { ObjectFetcher } = installed('@teambit/legacy.scope/dist/objects-fetcher/objects-fetcher.js');
const { ObjectsWritable } = installed('@teambit/legacy.scope/dist/objects-fetcher/objects-writable-stream.js');
const native =
  process.env.BIT_TEST_OBJECT_IMPORT || path.resolve(__dirname, '../../native/target/debug/bit-object-import');
const unix = process.platform === 'linux' || process.platform === 'darwin';
const hasNative = unix && require('node:fs').existsSync(native);
async function setup(t, { enabled = true, executable = native, abortAfterBytes, operation = false, signal, delayMs = 0, hold = false } = {}) {
  const getToken = Http.getToken;
  Http.getToken = () => 'fixture-token';
  t.after(() => {
    Http.getToken = getToken;
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-http-tar-'));
  const repo = await Repository.create({ scopePath: directory, scopeJson: { name: 'test' } });
  const values = ['first HTTP source', 'second HTTP source'].map((text) => Source.from(Buffer.from(text)));
  const history = VersionHistory.create('component', 'scope', [{ hash: new Ref('4'.repeat(40)), parents: [] }]);
  const objects = [values[0], history, values[1]];
  const pack = installed('tar-stream').pack();
  pack.entry({ name: '.BIT.START' }, Buffer.from('{"schema":"1.0.0","scopeName":"remote"}'));
  for (const object of objects) pack.entry({ name: `remote/${object.hash()}` }, await object.compress());
  pack.entry({ name: '.BIT.END' }, Buffer.from('true'));
  pack.finalize();
  const chunks = [];
  for await (const chunk of pack) chunks.push(chunk);
  const archive = Buffer.concat(chunks);
  let requests = 0,
    deferred,
    claimed = false,
    nativeSources = 0;
  const server = http.createServer((request, response) => {
    requests++;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/api/scope/fetch');
    assert.equal(request.headers.authorization, 'Bearer fixture-token');
    request.resume();
    response.writeHead(200, hold ? {} : { 'Content-Length': archive.length });
    if (abortAfterBytes !== undefined) {
      response.write(archive.subarray(0, abortAfterBytes));
      setTimeout(() => response.destroy(), 20);
    } else if (hold) response.write(archive);
    else if (delayMs) setTimeout(() => response.end(archive), delayMs);
    else response.end(archive);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = new Http(
    {},
    'fixture-token',
    `http://127.0.0.1:${server.address().port}`,
    'remote',
    undefined,
    undefined,
    undefined,
    { fetchRetries: 0 }
  );
  const names = ['BIT_RUST_OBJECT_TAR', 'BIT_RUST_OBJECT_IMPORT', 'BIT_RUST_OBJECT_IMPORT_OPERATION'];
  const previous = names.map((name) => process.env[name]);
  process.env.BIT_RUST_OBJECT_TAR = enabled ? 'on' : 'off';
  process.env.BIT_RUST_OBJECT_IMPORT = executable;
  process.env.BIT_RUST_OBJECT_IMPORT_OPERATION = operation ? 'on' : 'off';
  const prepare = ObjectsWritable.prototype.prepareTarBatch;
  ObjectsWritable.prototype.prepareTarBatch = function (entries, ...args) {
    nativeSources += entries.filter((entry) => entry.sourceHash).length;
    return prepare.call(this, entries, ...args);
  };
  t.after(async () => {
    ObjectsWritable.prototype.prepareTarBatch = prepare;
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const fetcher = new ObjectFetcher(
    repo,
    { sources: {} },
    {
      resolve: async () => ({
        fetch: async (ids, options, context) => {
          const stream = await client.fetch(ids, options, context);
          deferred = Boolean(stream.claimTarInput);
          if (stream.claimTarInput) {
            const claim = stream.claimTarInput.bind(stream);
            stream.claimTarInput = () => {
              claimed = true;
              return claim();
            };
          }
          return stream;
        },
      }),
    },
    {},
    [],
    undefined,
    undefined,
    true,
    { remote: objects.map((object) => object.hash().toString()) },
    'HTTP qualification',
    signal
  );
  return {
    repo,
    values,
    history,
    objects,
    fetcher,
    directory,
    requests: () => requests,
    deferred: () => deferred,
    claimed: () => claimed,
    nativeSources: () => nativeSources,
  };
}
async function verify(state) {
  assert.deepEqual(
    await state.fetcher.fetchFromRemoteAndWrite(),
    state.objects.map((object) => object.hash().toString())
  );
  for (const value of state.values) assert.deepEqual((await state.repo.load(value.hash())).contents, value.contents);
  assert.equal((await state.repo.load(state.history.hash())).getType(), 'VersionHistory');
  assert.equal(state.requests(), 1);
}
test(
  'actual Http.fetch and ObjectFetcher use native staged mixed-object intake when explicitly enabled',
  { skip: !hasNative },
  async (t) => {
    const state = await setup(t);
    await verify(state);
    assert.equal(state.deferred(), true);
    assert.equal(state.nativeSources(), 2);
    assert.equal(state.claimed(), true);
  }
);
test('disabled tar intake uses the existing HTTP decoder and writer', async (t) => {
  const state = await setup(t, { enabled: false, executable: 'off' });
  await verify(state);
  assert.equal(state.deferred(), false);
  assert.equal(state.nativeSources(), 0);
});
test('enabled tar with unavailable helper completes through canonical fallback without refetching', async (t) => {
  const state = await setup(t, { executable: path.join(os.tmpdir(), 'missing-bit-tar-helper') });
  await verify(state);
  assert.equal(state.deferred(), true);
  assert.equal(state.nativeSources(), 0);
});
test('custom persistence hooks keep deferred HTTP streams on the existing writer path', async (t) => {
  const state = await setup(t, { executable: path.join(os.tmpdir(), 'missing-bit-tar-helper') });
  let persisted = 0;
  state.repo.onPersist = (buffer) => {
    persisted++;
    return buffer;
  };
  await verify(state);
  assert.equal(persisted, 3);
  assert.equal(state.nativeSources(), 0);
  assert.equal(state.claimed(), false);
});
test(
  'interrupted original HTTP transfer replays its complete Source prefix and retains remote attribution',
  { skip: !unix },
  async (t) => {
    const state = await setup(t, {
      executable: path.join(os.tmpdir(), 'missing-bit-tar-helper'),
      abortAfterBytes: 2048,
    });
    await assert.rejects(state.fetcher.fetchFromRemoteAndWrite(), (error) => {
      assert.match(error.message, /remote .*remote.* responded with the following error/);
      return true;
    });
    assert.deepEqual((await state.repo.load(state.values[0].hash())).contents, state.values[0].contents);
    assert.equal(await state.repo.load(state.values[1].hash()), null);
    assert.equal(state.requests(), 1);
  }
);
test('staging disk failure replays the original HTTP response without a second request', { skip: !unix }, async (t) => {
  const state = await setup(t, { executable: path.join(os.tmpdir(), 'missing-bit-tar-helper') });
  const original = fs.open;
  let failed = false;
  fs.open = async (filename, ...args) => {
    if (String(filename).includes('bit-tar-stage-')) {
      failed = true;
      throw Object.assign(new Error('no space for HTTP stage'), { code: 'ENOSPC' });
    }
    return original(filename, ...args);
  };
  t.after(() => {
    fs.open = original;
  });
  await verify(state);
  assert.equal(failed, true);
  assert.equal(state.nativeSources(), 0);
});
test(
  'packaged runtime selects the trusted helper for the actual HTTP import path',
  { skip: !unix || !process.env.BIT_TEST_OBJECT_ARTIFACT },
  async (t) => {
    const { install } = require('./artifacts/install-helper.cjs');
    const directory = path.join(path.dirname(installed.resolve('@teambit/objects')), 'objects');
    install(directory, process.env.BIT_TEST_OBJECT_ARTIFACT);
    const state = await setup(t, { executable: 'packaged' });
    await verify(state);
    assert.equal(state.claimed(), true);
    assert.equal(state.nativeSources(), 2);
  }
);
test('operation-level native transfer preserves authenticated delayed HTTP import', { skip: !hasNative }, async (t) => {
  const state = await setup(t, { operation: true, delayMs: 50 }); await verify(state); assert.equal(state.nativeSources(), 2);
});
test('external cancellation aborts authenticated HTTP before response headers without retrying', { skip: !hasNative }, async (t) => {
  const controller = new AbortController(); const reason = new Error('caller HTTP cancellation');
  const state = await setup(t, { operation: true, signal: controller.signal, delayMs: 500 }); const pending = state.fetcher.fetchFromRemoteAndWrite();
  const rejected = assert.rejects(pending, (error) => error === reason);
  const started = Date.now(); while (!state.requests()) { assert.ok(Date.now() - started < 5000); await new Promise((resolve) => setTimeout(resolve, 5)); }
  controller.abort(reason); await rejected; assert.equal(state.requests(), 1); assert.equal(await state.repo.load(state.values[0].hash()), null);
});
test('external cancellation during native intake retains committed Source prefix and finishes helper cleanup', { skip: !hasNative }, async (t) => {
  const controller = new AbortController(); const reason = new Error('caller active intake cancellation');
  const state = await setup(t, { operation: true, signal: controller.signal, hold: true }); const pending = state.fetcher.fetchFromRemoteAndWrite(); const rejected = assert.rejects(pending, (error) => error === reason);
  const started = Date.now(); for (;;) {
    try { await fs.access(state.repo.objectPath(state.values[0].hash())); break; } catch { assert.ok(Date.now() - started < 5000, 'Source must commit before transport EOF'); await new Promise((resolve) => setTimeout(resolve, 5)); }
  }
  controller.abort(reason); await rejected; assert.equal(state.requests(), 1); assert.deepEqual((await state.repo.load(state.values[0].hash())).contents, state.values[0].contents);
});
