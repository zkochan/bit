// Requires the physically isolated, compiled Bit CLI used by the repository qualification suites.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { installed } = require('./load-source.cjs');
const { Repository, Source, Ref, VersionHistory } = installed('@teambit/objects');
const { ObjectsWritable } = installed('@teambit/legacy.scope/dist/objects-fetcher/objects-writable-stream.js');
const { WriteObjectsQueue } = installed('@teambit/legacy.scope/dist/objects-fetcher/write-objects-queue.js');
async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-tar-coordination-'));
  const repo = await Repository.create({ scopePath: directory, scopeJson: { name: 'test' } });
  const queue = new WriteObjectsQueue();
  const writer = new ObjectsWritable(repo, 'remote', queue, {});
  t.after(async () => {
    writer.destroy();
    await queue.onIdle();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { repo, writer, queue };
}
async function item(text) {
  const object = Source.from(Buffer.from(text));
  return { object, buffer: await object.compress(), hash: object.hash().toString() };
}
const descriptor = (value) => ({ name: `scope/${value.hash}`, sourceHash: value.hash });
const unix = process.platform === 'linux' || process.platform === 'darwin';
const executable =
  process.env.BIT_TEST_OBJECT_IMPORT || path.resolve(__dirname, '../../native/target/debug/bit-object-import');
test(
  'shared remote queue reserves validated Sources once without loading compressed buffers',
  { skip: !unix },
  async (t) => {
    const { repo, writer, queue } = await setup(t);
    assert.equal(repo.canWriteMutableObjectsNatively(), true);
    const value = await item('shared source');
    const other = new ObjectsWritable(repo, 'other', queue, {});
    t.after(() => other.destroy());
    const load = () => {
      throw new Error('Source bytes must stay in Rust');
    };
    const first = await writer.prepareTarBatch([descriptor(value), descriptor(value)], load);
    const second = await other.prepareTarBatch([descriptor(value)], load);
    assert.deepEqual(first.selected, [0]);
    assert.deepEqual(second.selected, []);
    assert.deepEqual(queue.addedHashes, [value.hash]);
    await first.settle(new Set([0]));
    await second.settle(new Set());
    await assert.rejects(first.settle(new Set([0])), /already settled/);
  }
);
test('uncertain Source writes repair canonically and invalidate both cache layers', { skip: !unix }, async (t) => {
  const { repo, writer } = await setup(t);
  const value = await item('repair source');
  await repo.writeObjectsToTheFS([value.object]);
  const cached = await repo.load(value.object.hash());
  cached.contents = Buffer.from('stale');
  let loads = 0;
  const decision = await writer.prepareTarBatch([descriptor(value)], async () => {
    loads++;
    return value.buffer;
  });
  assert.equal(loads, 0);
  await decision.settle();
  assert.equal(loads, 1);
  assert.equal((await repo.load(new Ref(value.hash))).contents.toString(), 'repair source');
});
test('partial acknowledgement repairs only failed Sources', { skip: !unix }, async (t) => {
  const { repo, writer } = await setup(t);
  const values = await Promise.all(['acknowledged', 'failed'].map(item));
  const loads = [];
  const decision = await writer.prepareTarBatch(values.map(descriptor), async (index) => {
    loads.push(index);
    return values[index].buffer;
  });
  await repo.writeObjectsToTheFS([values[0].object]);
  await decision.settle(new Set([0]));
  assert.deepEqual(loads, [1]);
  for (const value of values)
    assert.equal((await repo.load(value.object.hash())).contents.toString(), value.object.contents.toString());
});
test('custom persistence hooks retain canonical writes and receive Source bytes', async (t) => {
  const { repo, writer, queue } = await setup(t);
  const value = await item('hook source');
  let called = 0;
  repo.onPersist = (buffer) => {
    called++;
    return buffer;
  };
  const decision = await writer.prepareTarBatch([descriptor(value)], async () => value.buffer);
  await decision.settle(new Set());
  await queue.onIdle();
  assert.deepEqual(decision.selected, []);
  assert.equal(called, 1);
  assert.equal((await repo.load(value.object.hash())).contents.toString(), 'hook source');
});
test(
  'ordered metadata merge runs once before a later marker error; reserved prefix remains selectable',
  { skip: !unix },
  async (t) => {
    const { repo, writer, queue } = await setup(t);
    const value = await item('prefix');
    const history = VersionHistory.create('component', 'scope', [{ hash: new Ref('1'.repeat(40)), parents: [] }]);
    const buffer = await history.compress();
    const loads = [];
    const decision = await writer.prepareTarBatch(
      [descriptor(value), { name: `scope/${history.hash()}` }, { name: '.BIT.END' }, descriptor(value)],
      async (index) => {
        loads.push(index);
        return index === 1 ? buffer : value.buffer;
      }
    );
    assert.deepEqual(decision.selected, [0]);
    assert.match(decision.error.message, /markers must be processed/);
    await decision.settle();
    await queue.onIdle();
    assert.deepEqual(loads, [1, 0]);
    assert.equal((await repo.load(history.hash())).getType(), 'VersionHistory');
    assert.deepEqual(queue.addedHashes, [value.hash, history.hash().toString()]);
  }
);
test('cancellation invalidates reserved Sources without starting repairs', { skip: !unix }, async (t) => {
  const { writer } = await setup(t);
  const value = await item('cancel');
  const decision = await writer.prepareTarBatch([descriptor(value)], async () => {
    throw new Error('repair after cancellation');
  });
  await decision.settle(undefined, false);
});
test('repair rejects a changed staged Source identity', { skip: !unix }, async (t) => {
  const { writer } = await setup(t);
  const value = await item('original');
  const changed = await item('changed');
  const decision = await writer.prepareTarBatch([descriptor(value)], async () => changed.buffer);
  await assert.rejects(decision.settle(), /Source changed/);
});
test('metadata can disable native persistence after reservation', { skip: !unix }, async (t) => {
  const { repo, writer } = await setup(t);
  const values = await Promise.all(['reserved', 'canonical'].map(item));
  let persisted = 0;
  const decision = await writer.prepareTarBatch([descriptor(values[0]), { name: values[1].hash }], async (index) => {
    if (index === 1)
      repo.onPersist = (buffer) => {
        persisted++;
        return buffer;
      };
    return values[index].buffer;
  });
  assert.deepEqual(decision.selected, []);
  await decision.settle(new Set());
  assert.equal(persisted, 2);
});
test(
  'real tar helper persists Sources while the repository merges metadata from staged ranges',
  { skip: !unix || !require('node:fs').existsSync(executable) },
  async (t) => {
    const { repo, writer, queue } = await setup(t);
    const { readTarBatches } = require('./tar-batch-client.cjs');
    const value = await item('native Source with repository metadata');
    const history = VersionHistory.create('component', 'scope', [{ hash: new Ref('2'.repeat(40)), parents: [] }]);
    const archive = path.join(repo.scopePath, 'mixed.tar');
    const pack = installed('tar-stream').pack();
    pack.entry({ name: `scope/${value.hash}` }, value.buffer);
    pack.entry({ name: `scope/${history.hash()}` }, await history.compress());
    pack.finalize();
    const chunks = [];
    for await (const chunk of pack) chunks.push(chunk);
    await fs.writeFile(archive, Buffer.concat(chunks));
    const handle = await fs.open(archive);
    const options = await repo.getNativeSourceStoreOptions();
    const loaded = [];
    try {
      const stats = await readTarBatches(executable, archive, { ...options, awaitSelection: true }, (files, signal) => {
        return writer.prepareTarBatch(
          files.map((file) => ({
            name: file.name,
            sourceHash: file.validation?.status === 'source' ? file.validation.hash : undefined,
          })),
          async (index) => {
            loaded.push(index);
            const file = files[index];
            const buffer = Buffer.alloc(file.size);
            assert.equal((await handle.read(buffer, 0, buffer.length, file.offset)).bytesRead, file.size);
            return buffer;
          },
          signal
        );
      });
      assert.deepEqual(stats, { count: 2, persisted: 1, batches: 1 });
      await queue.onIdle();
      assert.deepEqual(loaded, [1]);
      assert.equal(
        (await repo.load(new Ref(value.hash))).contents.toString(),
        'native Source with repository metadata'
      );
      assert.equal((await repo.load(history.hash())).getType(), 'VersionHistory');
    } finally {
      await handle.close();
    }
  }
);
