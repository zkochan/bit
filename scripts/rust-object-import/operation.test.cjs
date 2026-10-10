const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const { root, source } = require('./load-source.cjs');
const { NativeImportOperation, nativeIndices, nativeSelections } = source(
  'scopes/scope/objects/objects/rust-object-operation.ts'
);
const { transfer } = source('components/legacy/scope/objects-fetcher/rust-tar-transfer.ts');
const native =
  process.env.BIT_TEST_OBJECT_IMPORT ||
  path.join(root, 'native/target/debug/bit-object-import' + (process.platform === 'win32' ? '.exe' : ''));
async function setup(t, executable = native, timeout = 10000, args = []) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-operation-'));
  const operation = new NativeImportOperation(executable, { objectsDirectory: directory }, timeout, args);
  t.after(async () => {
    await operation.disposeAndWait();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, operation };
}
const identity = (value) => value;
test('Version compares canonical date strings in UTF-16 order', async (t) => {
  const { operation } = await setup(t);
  const cases = [
    ['10', '9'],
    ['9', '10'],
    ['𝄞', '\ue000'],
    ['日本', 'λ'],
    ['', ''],
    ['0', ''],
  ];
  const result = await Promise.all(
    cases.map(([existing, incoming]) => operation.request({ kind: 'version', existing, incoming }, identity))
  );
  assert.deepEqual(
    result,
    cases.map(([existing, incoming]) => existing > incoming)
  );
  assert.equal(operation.stats.frames, 1, 'ready work coalesces without a timer');
});
test('VersionHistory respects original map keys when shared Refs change', async (t) => {
  const { operation } = await setup(t);
  assert.deepEqual(
    await operation.request(
      {
        kind: 'versionHistory',
        existing: ['mutated', 'keep', 'replace'],
        stored: ['old', 'keep', 'replace'],
        incoming: ['replace', 'new'],
      },
      identity
    ),
    [1]
  );
});
test('LaneHistory overlays incoming entries while preserving insertion positions', async (t) => {
  const { operation } = await setup(t);
  assert.deepEqual(
    await operation.request({ kind: 'laneHistory', existing: ['a', 'b', 'c'], incoming: ['b', 'd', 'a'] }, identity),
    [
      [1, 2],
      [1, 0],
      [0, 2],
      [1, 1],
    ]
  );
});
test('component origin, cache, local conflicts and detached histories produce bounded plans', async (t) => {
  const { operation } = await setup(t);
  const base = {
    kind: 'component',
    existing: [
      ['1.0.0', 'old'],
      ['2.0.0', 'local'],
      ['3.0.0', 'drop'],
    ],
    incoming: [
      ['1.0.0', 'new'],
      ['4.0.0', 'add'],
    ],
    orphaned: [['5.0.0', 'orphan']],
    local: ['2.0.0'],
    origin: true,
    heads: [
      ['old', 'same'],
      ['same', 'new'],
    ],
    deleted: [['gone'], ['gone', 'other']],
  };
  assert.deepEqual(await operation.request(base, identity), {
    conflicts: [],
    actions: [
      ['tag', 1, 0],
      ['remove', 0, 2],
      ['tag', 1, 1],
      ['orphan', 2, 0],
    ],
    heads: [
      [0, 0],
      [0, 1],
      [1, 1],
    ],
    deleted: [
      [0, 0],
      [1, 1],
    ],
  });
  assert.deepEqual((await operation.request({ ...base, origin: false }, identity)).actions, [
    ['orphan', 1, 1],
    ['orphan', 2, 0],
  ]);
  assert.deepEqual(await operation.request({ ...base, local: ['1.0.0'] }, identity), { conflicts: ['1.0.0'] });
});
test('index plans preserve duplicates and sequential lane rename-back', async (t) => {
  const { operation } = await setup(t);
  const id = { name: 'old', scope: null };
  const changed = { name: 'new', scope: null };
  const entry = { hash: 'lane', id };
  assert.deepEqual(
    await operation.request(
      {
        kind: 'index',
        components: [],
        lanes: [entry],
        objects: [
          { ...entry, id: changed, category: 'lane' },
          { ...entry, category: 'lane' },
          { hash: 'component', id, category: 'component' },
          { hash: 'component', id: changed, category: 'component' },
        ],
      },
      identity
    ),
    [
      ['rename', 0, 0],
      ['rename', 1, 0],
      ['add', 2, 0],
    ]
  );
  assert.equal(
    await operation.request(
      { kind: 'index', components: [entry], lanes: [], objects: [{ ...entry, category: 'lane' }] },
      identity
    ),
    null
  );
});
test('ordered same-hash persistence replaces canonical bytes and rejects unsupported objects individually', async (t) => {
  const { directory, operation } = await setup(t);
  const hash = '1'.padStart(40, '0');
  const serialized = (type, text) => Buffer.from(`${type} ${hash} ${text.length}\0${text}`).toString('hex');
  const result = await Promise.all(
    ['first', 'second'].map((text) =>
      operation.request({ kind: 'persist', hash, serialized: serialized('Component', text) }, identity)
    )
  );
  assert.ok(result.every((size) => size > 0));
  assert.equal(
    zlib.inflateSync(await fs.readFile(path.join(directory, '00', hash.slice(2)))).toString(),
    `Component ${hash} 6\0second`
  );
  assert.equal(
    await operation.request({ kind: 'persist', hash, serialized: serialized('Source', 'invalid') }, identity),
    null
  );
});
test('invalid trailing operation and truncated frames cannot persist a prefix', async (t) => {
  const { directory } = await setup(t);
  const hash = '1'.padStart(40, '0');
  const body = Buffer.from(
    JSON.stringify([
      { kind: 'persist', hash, serialized: Buffer.from(`Version ${hash} 2\0{}`).toString('hex') },
      { kind: 'unknown' },
    ])
  );
  const header = Buffer.alloc(12);
  header.write('BOP1');
  header.writeUInt32BE(1, 4);
  header.writeUInt32BE(body.length, 8);
  for (const input of [Buffer.concat([header, body]), Buffer.concat([header, body.subarray(0, -1)])]) {
    const result = cp.spawnSync(native, ['--objects-dir', directory], { input });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout.length, 0);
    assert.deepEqual(await fs.readdir(directory), []);
  }
});
test('native tar spool transfers multiple chunks and refuses stale offsets', async (t) => {
  const { directory, operation } = await setup(t);
  const archive = path.join(directory, 'input.tar');
  const chunks = [Buffer.alloc(1024 * 1024 + 17, 65), Buffer.from('日本語')];
  const state = { archive, bytes: 0, offset: 0, replayable: true };
  await transfer(Readable.from(chunks), state, 2 * 1024 * 1024, new AbortController().signal, () => operation);
  assert.deepEqual(await fs.readFile(archive), Buffer.concat(chunks));
  assert.equal(state.bytes, Buffer.concat(chunks).length);
  const { operation: stale } = await setup(t);
  await fs.writeFile(path.join(stale.objectsDirectory, 'input.tar'), 'existing');
  assert.equal(await stale.appendArchive(0, Buffer.from('x'), 100), undefined);
  assert.equal(await fs.readFile(path.join(stale.objectsDirectory, 'input.tar'), 'utf8'), 'existing');
});
test('spool fallback verifies and continues an unacknowledged prefix exactly once', async (t) => {
  const { directory } = await setup(t);
  const archive = path.join(directory, 'input.tar');
  let reaped = false;
  const state = { archive, bytes: 0, offset: 0, replayable: true };
  const spool = {
    async appendArchive(_offset, buffer) {
      await fs.appendFile(archive, buffer.subarray(0, 3));
      reaped = true;
      return undefined;
    },
    async disposeAndWait() {},
  };
  await transfer(
    Readable.from([Buffer.from('first-chunk'), Buffer.from('second')]),
    state,
    100,
    new AbortController().signal,
    () => spool
  );
  assert.ok(reaped);
  assert.equal(await fs.readFile(archive, 'utf8'), 'first-chunksecond');
  assert.equal(state.bytes, 17);
});
test('corrupt unacknowledged bytes disable staged replay', async (t) => {
  const { directory } = await setup(t);
  const archive = path.join(directory, 'input.tar');
  const state = { archive, bytes: 0, offset: 0, replayable: true };
  await assert.rejects(
    transfer(Readable.from([Buffer.from('good')]), state, 100, new AbortController().signal, () => ({
      async appendArchive() {
        await fs.appendFile(archive, 'bad');
        return undefined;
      },
      async disposeAndWait() {},
    })),
    /changed pending bytes/
  );
  assert.equal(state.replayable, false);
});
test('old helpers, timeouts and malformed responses settle only after helper termination', async (t) => {
  for (const program of [
    'process.stdin.resume()',
    'process.stdin.once(\'data\',()=>process.stdout.write(\'{"version":1,"id":1,"results":[]}\\n\'))',
    "process.stdin.once('data',()=>process.exit(1))",
  ]) {
    const { operation } = await setup(t, process.execPath, 40, ['-e', program, '--']);
    assert.equal(await operation.request({ kind: 'version', existing: '2', incoming: '1' }, identity), undefined);
    assert.ok(operation.unavailableReason);
    assert.equal(await operation.request({}, identity), undefined);
  }
});
test('selectors reject malformed, repeated and out-of-range values', () => {
  for (const value of [[0, 0], [-1], [1], [0.1], null]) assert.throws(() => nativeIndices(value, 1));
  for (const value of [
    [
      [0, 0],
      [0, 0],
    ],
    [[1, 0]],
    [[0, 1]],
    [[0, -1]],
    [[0]],
    null,
  ])
    assert.throws(() => nativeSelections(value, [1]));
  assert.deepEqual(nativeSelections([[0, 0]], [1]), [[0, 0]]);
});
test(
  'Linux index commits preserve modes, named ACLs and extended attributes; links fall back',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const scope = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-index-metadata-'));
    const directory = path.join(scope, 'objects');
    await fs.mkdir(directory);
    const operation = new NativeImportOperation(native, { objectsDirectory: directory });
    t.after(async () => {
      await operation.disposeAndWait();
      await fs.rm(scope, { recursive: true, force: true });
    });
    const index = path.join(scope, 'index.json');
    await fs.writeFile(index, '{}\n', { mode: 0o640 });
    const python = process.env.PYTHON || 'python3';
    cp.execFileSync(python, ['-c', "import os,sys;os.setxattr(sys.argv[1],'user.bit-test',b'index-metadata')", index]);
    const acl = cp.spawnSync('setfacl', ['-m', 'u:65534:r--', index]);
    if (acl.error) {
      t.diagnostic('setfacl unavailable: named ACL coverage is required in Linux CI');
    } else assert.equal(acl.status, 0, acl.stderr.toString());
    const before = await fs.stat(index);
    const originalAcl = acl.error ? undefined : cp.execFileSync('getfacl', ['-cp', index], { encoding: 'utf8' });
    const contents = '{\n  "components": [],\n  "lanes": []\n}\n';
    assert.equal(await operation.request({ kind: 'indexWrite', contents }, identity), true);
    assert.equal(await fs.readFile(index, 'utf8'), contents);
    const after = await fs.stat(index);
    assert.equal(after.mode, before.mode);
    assert.equal(after.uid, before.uid);
    assert.equal(after.gid, before.gid);
    assert.equal(
      cp
        .execFileSync(python, ['-c', "import os,sys;print(os.getxattr(sys.argv[1],'user.bit-test').decode())", index], {
          encoding: 'utf8',
        })
        .trim(),
      'index-metadata'
    );
    if (originalAcl) assert.equal(cp.execFileSync('getfacl', ['-cp', index], { encoding: 'utf8' }), originalAcl);
    if (!acl.error) {
      cp.execFileSync('setfacl', ['-b', index]);
      cp.execFileSync('setfacl', ['-m', 'd:u:65534:r--', scope]);
      const plain = cp.execFileSync('getfacl', ['-cp', index], { encoding: 'utf8' });
      assert.equal(await operation.request({ kind: 'indexWrite', contents }, identity), true);
      assert.equal(
        cp.execFileSync('getfacl', ['-cp', index], { encoding: 'utf8' }),
        plain,
        'new parent default ACL must not change an existing index'
      );
    }
    await fs.chmod(index, 0o4640);
    assert.equal(
      await operation.request({ kind: 'indexWrite', contents: '{}' }, identity),
      false,
      'special mode bits need canonical in-place writes that clear them'
    );
    assert.equal(await fs.readFile(index, 'utf8'), contents);
    await fs.chmod(index, 0o640);
    const linked = path.join(scope, 'linked');
    await fs.link(index, linked);
    assert.equal(await operation.request({ kind: 'indexWrite', contents: '{}' }, identity), false);
    assert.equal(await fs.readFile(linked, 'utf8'), contents);
    await fs.unlink(index);
    await fs.symlink(linked, index);
    assert.equal(await operation.request({ kind: 'indexWrite', contents: '{}' }, identity), false);
    assert.ok((await fs.lstat(index)).isSymbolicLink());
  }
);
test('plans based on stale live values fall back before application', async (t) => {
  const { operation } = await setup(t);
  let existing = ['old'];
  const plan = operation.plan(() => ({ kind: 'laneHistory', existing, incoming: ['new'] }), identity);
  existing = ['old', 'other-remote'];
  assert.equal((await plan).apply(identity), undefined);
  assert.equal(operation.stats.stalePlans, 1);
  assert.deepEqual(
    (await operation.plan(() => ({ kind: 'laneHistory', existing, incoming: ['new'] }), identity)).apply(identity),
    [
      [0, 0],
      [0, 1],
      [1, 0],
    ]
  );
});

test('unsupported projections select canonical policy without submitting or breaking a healthy session', async (t) => {
  const { operation } = await setup(t);
  const cyclic = {};
  cyclic.self = cyclic;
  for (const project of [
    () => cyclic,
    () => ({ value: 1n }),
    () => {
      throw new Error('unsupported projection');
    },
  ])
    assert.equal(await operation.plan(project, identity), undefined);
  assert.equal(operation.stats.frames, 0);
  let changed = false;
  const plan = await operation.plan(() => {
    if (changed) throw new Error('changed projection');
    return { kind: 'version', existing: '9', incoming: '10' };
  }, identity);
  changed = true;
  assert.equal(
    plan.apply(() => {
      throw new Error('stale plan must not apply');
    }),
    undefined
  );
  assert.equal(operation.stats.stalePlans, 1);
  assert.equal(await operation.request({ kind: 'version', existing: '9', incoming: '10' }, identity), true);
  assert.equal(operation.unavailableReason, undefined);
});
