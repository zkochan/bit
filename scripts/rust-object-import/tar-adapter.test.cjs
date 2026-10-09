const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { installed } = require('./load-source.cjs');
const { Repository, Source, Ref, VersionHistory } = installed('@teambit/objects');
const { ObjectsWritable } = installed('@teambit/legacy.scope/dist/objects-fetcher/objects-writable-stream.js');
const { WriteObjectsQueue } = installed('@teambit/legacy.scope/dist/objects-fetcher/write-objects-queue.js');
const { importStagedTar, TarRemoteError } = installed(
  '@teambit/legacy.scope/dist/objects-fetcher/rust-tar-importer.js'
);
const native =
  process.env.BIT_TEST_OBJECT_IMPORT || path.resolve(__dirname, '../../native/target/debug/bit-object-import');
const unix = process.platform === 'linux' || process.platform === 'darwin';
const hasNative = unix && require('node:fs').existsSync(native);
async function setup(t, markers = true) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-tar-adapter-'));
  const repo = await Repository.create({ scopePath: directory, scopeJson: { name: 'test' } });
  const queue = new WriteObjectsQueue();
  const writer = new ObjectsWritable(repo, 'remote', queue, {});
  const values = ['prefix', 'suffix'].map((text) => Source.from(Buffer.from(text)));
  const history = VersionHistory.create('component', 'scope', [{ hash: new Ref('3'.repeat(40)), parents: [] }]);
  const pack = installed('tar-stream').pack();
  if (markers) pack.entry({ name: '.BIT.START' }, Buffer.from(JSON.stringify({ schema: '1.0.0' })));
  for (const object of [values[0], history, values[1]])
    pack.entry({ name: `scope/${object.hash()}` }, await object.compress());
  if (markers) pack.entry({ name: '.BIT.END' }, Buffer.from('true'));
  pack.finalize();
  const chunks = [];
  for await (const chunk of pack) chunks.push(chunk);
  const archive = path.join(directory, 'archive.tar');
  await fs.writeFile(archive, Buffer.concat(chunks));
  let merges = 0;
  const original = writer.mergeVersionHistory.bind(writer);
  writer.mergeVersionHistory = async (value) => {
    merges++;
    return original(value);
  };
  t.after(async () => {
    writer.destroy();
    await queue.onIdle();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, repo, writer, queue, values, history, archive, merges: () => merges };
}
async function verify(state) {
  await state.queue.onIdle();
  for (const object of state.values) assert.deepEqual((await state.repo.load(object.hash())).contents, object.contents);
  assert.equal((await state.repo.load(state.history.hash())).getType(), 'VersionHistory');
  assert.equal(state.merges(), 1);
}
test(
  'production adapter processes mixed objects and marker policy through the real helper',
  { skip: !hasNative },
  async (t) => {
    const state = await setup(t);
    const result = await importStagedTar(
      native,
      state.archive,
      state.writer,
      await state.repo.getNativeSourceStoreOptions()
    );
    assert.deepEqual(result, { objects: 3, nativeSources: 2, fallback: false });
    await verify(state);
  }
);
test('missing helper falls back to the canonical decoder and repository writer', async (t) => {
  const state = await setup(t);
  const result = await importStagedTar(path.join(state.directory, 'missing-helper'), state.archive, state.writer, {});
  assert.deepEqual(result, { objects: 3, nativeSources: 0, fallback: true });
  await verify(state);
});
test(
  'native prefix with lost acknowledgement repairs Sources and skips its completed metadata on continuation',
  { skip: !hasNative },
  async (t) => {
    const state = await setup(t, false);
    const { readTarBatches } = installed('@teambit/legacy.scope/dist/objects-fetcher/rust-tar-client.js');
    let records;
    await readTarBatches(native, state.archive, {}, async (files) => {
      records = files;
      return { selected: [] };
    });
    const prefix = records.slice(0, 2);
    const target = state.repo.objectPath(state.values[0].hash());
    const body = await state.values[0].compress();
    // Real executable process writes the Source but exits instead of acknowledging its commit.
    const script = path.join(state.directory, 'lost-ack.cjs');
    const code = `#!/usr/bin/env node\nconst fs=require('fs'); let data=Buffer.alloc(0), sent=false;
process.stdin.on('data', chunk=>{data=Buffer.concat([data,chunk]);
if(!sent && data.length>=16 && data.length>=16+data.readUInt32BE(12)) {
data=data.subarray(16+data.readUInt32BE(12)); sent=true;
process.stdout.write(JSON.stringify(${JSON.stringify({ version: 1, id: 1, sequence: 0, done: false, fallback: false, error: null, files: prefix })})+'\\n');
}
if(sent && data.length>=16 && data.subarray(0,4).toString()==='BTC1') {
fs.mkdirSync(${JSON.stringify(path.dirname(target))},{recursive:true});
fs.writeFileSync(${JSON.stringify(target)},Buffer.from(${JSON.stringify(body.toString('base64'))},'base64')); process.exit(1);
}});`;
    await fs.writeFile(script, code, { mode: 0o700 });
    const result = await importStagedTar(
      script,
      state.archive,
      state.writer,
      await state.repo.getNativeSourceStoreOptions()
    );
    assert.deepEqual(result, { objects: 3, nativeSources: 0, fallback: true });
    await verify(state);
    assert.deepEqual(state.queue.addedHashes, [
      state.values[0].hash().toString(),
      state.history.hash().toString(),
      state.values[1].hash().toString(),
    ]);
  }
);
test('canonical continuation keeps remote framing errors distinguishable from writable errors', async (t) => {
  const state = await setup(t);
  // A valid schema marker without END retains the original remote termination message.
  const bytes = await fs.readFile(state.archive);
  // END occupies one tar header and one padded body; the final two headers are archive termination.
  await fs.writeFile(state.archive, bytes.subarray(0, bytes.length - 2048));
  await assert.rejects(
    importStagedTar(path.join(state.directory, 'missing'), state.archive, state.writer, {}),
    (error) => {
      assert.ok(error instanceof TarRemoteError);
      assert.match(error.message, /server terminated the stream unexpectedly/);
      return true;
    }
  );
});
test('repository policy failure stays authoritative and is never retried', async (t) => {
  const state = await setup(t);
  let calls = 0;
  state.repo.onPersist = () => {
    calls++;
    throw new Error('custom persistence rejected');
  };
  await assert.rejects(importStagedTar(path.join(state.directory, 'missing'), state.archive, state.writer, {}), {
    message: 'custom persistence rejected',
  });
  assert.equal(calls, 1);
});
test('pre-cancelled imports do not replay through the canonical writer', async (t) => {
  const state = await setup(t);
  const control = new AbortController();
  control.abort(new Error('stop tar import'));
  await assert.rejects(importStagedTar(native, state.archive, state.writer, { signal: control.signal }), {
    message: 'stop tar import',
  });
  assert.equal(state.queue.added, 0);
});
test(
  'native ERROR marker preserves the remote message after committing the valid Source prefix',
  { skip: !hasNative },
  async (t) => {
    const state = await setup(t, false);
    const pack = installed('tar-stream').pack();
    pack.entry({ name: `scope/${state.values[0].hash()}` }, await state.values[0].compress());
    pack.entry({ name: '.BIT.ERROR' }, Buffer.from('remote denied this request'));
    pack.finalize();
    const chunks = [];
    for await (const chunk of pack) chunks.push(chunk);
    await fs.writeFile(state.archive, Buffer.concat(chunks));
    await assert.rejects(
      importStagedTar(native, state.archive, state.writer, await state.repo.getNativeSourceStoreOptions()),
      (error) => {
        assert.ok(error instanceof TarRemoteError);
        assert.equal(error.message, 'remote denied this request');
        return true;
      }
    );
    assert.deepEqual((await state.repo.load(state.values[0].hash())).contents, state.values[0].contents);
    assert.equal(state.merges(), 0);
  }
);
test('native deadline is terminal and cannot fall back into repository writes', { skip: !unix }, async (t) => {
  const state = await setup(t);
  const script = path.join(state.directory, 'hang.cjs');
  await fs.writeFile(script, '#!/usr/bin/env node\nprocess.stdin.resume(); setInterval(()=>{},1000);', { mode: 0o700 });
  await assert.rejects(importStagedTar(script, state.archive, state.writer, { timeoutMs: 50 }), {
    message: 'tar operation timed out',
  });
  assert.equal(state.queue.added, 0);
});
test(
  'native policy failure commits the reserved Source prefix and never replays the failed merge',
  { skip: !hasNative },
  async (t) => {
    const state = await setup(t, false);
    let calls = 0;
    state.writer.mergeVersionHistory = async () => {
      calls++;
      throw new Error('metadata merge rejected');
    };
    await assert.rejects(
      importStagedTar(native, state.archive, state.writer, await state.repo.getNativeSourceStoreOptions()),
      { message: 'metadata merge rejected' }
    );
    assert.equal(calls, 1);
    assert.deepEqual((await state.repo.load(state.values[0].hash())).contents, state.values[0].contents);
    assert.equal(await state.repo.load(state.values[1].hash()), null);
  }
);
test(
  'cooperative repository cancellation finishes started metadata without repairing reserved Sources',
  { skip: !hasNative },
  async (t) => {
    const state = await setup(t, false);
    const control = new AbortController();
    const merge = state.writer.mergeVersionHistory.bind(state.writer);
    let completed = false;
    state.writer.mergeVersionHistory = async (value) => {
      control.abort(new Error('cancel during metadata'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      await merge(value);
      completed = true;
    };
    await assert.rejects(
      importStagedTar(native, state.archive, state.writer, {
        ...(await state.repo.getNativeSourceStoreOptions()),
        signal: control.signal,
      }),
      { message: 'cancel during metadata' }
    );
    assert.equal(completed, true);
    assert.equal(state.merges(), 1);
    assert.equal(await state.repo.load(state.values[0].hash()), null);
    assert.equal(await state.repo.load(state.values[1].hash()), null);
  }
);
test('invalid transport Ref remains a remote error after a valid Source prefix', { skip: !hasNative }, async (t) => {
  const state = await setup(t, false);
  const pack = installed('tar-stream').pack();
  const buffer = await state.values[0].compress();
  pack.entry({ name: `scope/${state.values[0].hash()}` }, buffer);
  pack.entry({ name: 'scope/' }, buffer);
  pack.finalize();
  const chunks = [];
  for await (const chunk of pack) chunks.push(chunk);
  await fs.writeFile(state.archive, Buffer.concat(chunks));
  await assert.rejects(
    importStagedTar(native, state.archive, state.writer, await state.repo.getNativeSourceStoreOptions()),
    (error) => {
      assert.ok(error instanceof TarRemoteError);
      assert.match(error.message, /hash argument is empty/);
      return true;
    }
  );
  assert.deepEqual((await state.repo.load(state.values[0].hash())).contents, state.values[0].contents);
});
test('disabling native metadata retains canonical mixed-object import', { skip: !hasNative }, async (t) => {
  const previous = process.env.BIT_RUST_OBJECT_IMPORT_METADATA;
  process.env.BIT_RUST_OBJECT_IMPORT_METADATA = 'off';
  t.after(() => {
    if (previous === undefined) delete process.env.BIT_RUST_OBJECT_IMPORT_METADATA;
    else process.env.BIT_RUST_OBJECT_IMPORT_METADATA = previous;
  });
  const state = await setup(t);
  const result = await importStagedTar(
    native,
    state.archive,
    state.writer,
    await state.repo.getNativeSourceStoreOptions()
  );
  assert.equal(result.fallback, false);
  assert.equal(result.nativeSources, 2);
  await verify(state);
});
test(
  'an older helper rejecting the metadata flag replays the archive before any native policy',
  { skip: !unix },
  async (t) => {
    const state = await setup(t);
    const executable = path.join(state.directory, 'old-helper');
    const flagFile = path.join(state.directory, 'request-flags');
    await fs.writeFile(
      executable,
      `#!/usr/bin/env node
const fs=require('node:fs');let input=Buffer.alloc(0);
process.stdin.on('data',chunk=>{input=Buffer.concat([input,chunk]);if(input.length>=16){const flags=input.readUInt32BE(8);fs.writeFileSync(${JSON.stringify(flagFile)},String(flags));process.exit(flags>1?1:2);}});
`,
      { mode: 0o700 }
    );
    const result = await importStagedTar(executable, state.archive, state.writer, {
      ...(await state.repo.getNativeSourceStoreOptions()),
      metadata: true,
    });
    assert.equal(await fs.readFile(flagFile, 'utf8'), '2');
    assert.equal(result.fallback, true);
    assert.equal(result.nativeSources, 0);
    await verify(state);
  }
);
test(
  'the direct adapter can explicitly retain Node metadata while persisting Sources natively',
  { skip: !hasNative },
  async (t) => {
    const state = await setup(t);
    const result = await importStagedTar(native, state.archive, state.writer, {
      ...(await state.repo.getNativeSourceStoreOptions()),
      metadata: false,
    });
    assert.equal(result.fallback, false);
    assert.equal(result.nativeSources, 2);
    await verify(state);
  }
);
test(
  'invalid Rust-inflated metadata retains the canonical error and persisted Source prefix',
  { skip: !hasNative },
  async (t) => {
    const state = await setup(t, false);
    const hash = 'a'.repeat(40);
    const buffer = require('node:zlib').deflateSync(Buffer.from(`VersionHistory ${hash} 0\0{"invalid":`));
    const { BitObject } = installed('@teambit/objects');
    let canonical;
    try {
      await BitObject.parseObjectWithSize(buffer);
    } catch (error) {
      canonical = error;
    }
    assert.ok(canonical);
    const pack = installed('tar-stream').pack();
    pack.entry({ name: `scope/${state.values[0].hash()}` }, await state.values[0].compress());
    pack.entry({ name: `scope/${hash}` }, buffer);
    pack.entry({ name: `scope/${state.values[1].hash()}` }, await state.values[1].compress());
    pack.finalize();
    const chunks = [];
    for await (const chunk of pack) chunks.push(chunk);
    await fs.writeFile(state.archive, Buffer.concat(chunks));
    await assert.rejects(
      importStagedTar(native, state.archive, state.writer, await state.repo.getNativeSourceStoreOptions()),
      (error) => {
        assert.equal(error.constructor, canonical.constructor);
        assert.equal(error.message, canonical.message);
        assert.equal(error instanceof TarRemoteError, false);
        return true;
      }
    );
    assert.deepEqual((await state.repo.load(state.values[0].hash())).contents, state.values[0].contents);
    assert.equal(await state.repo.load(state.values[1].hash()), null);
    assert.equal(state.merges(), 0);
  }
);
