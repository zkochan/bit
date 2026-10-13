const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { installed } = require('./load-source.cjs');
const { ModelComponent, Version, Source } = installed('@teambit/objects');
function request(root, targets, history = false) {
  const body = Buffer.from(JSON.stringify({ kind: 'statusModels', root, targets, history }));
  const header = Buffer.alloc(12);
  header.write('BWS1');
  header.writeUInt32BE(1, 4);
  header.writeUInt32BE(body.length, 8);
  return JSON.parse(
    execFileSync(process.env.BIT_TEST_OBJECT_IMPORT, {
      input: Buffer.concat([header, body]),
      encoding: 'utf8',
      maxBuffer: 40 * 1024 * 1024,
    })
  );
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-status-models-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const body = Source.from(Buffer.from('module.exports = 1;\n'));
  const version = new Version({
    hash: '1'.repeat(40),
    mainFile: 'index.js',
    files: [{ name: 'index.js', relativePath: 'index.js', file: body.hash(), test: false }],
    log: { date: '1700000000000', message: 'status' },
    dependencies: [],
    devDependencies: [],
    parents: [],
  });
  const models = Array.from({ length: 130 }, (_, i) =>
    ModelComponent.from({
      name: `component${i}`,
      scope: 'qualification.status',
      versions: { '1.0.0': version.hash() },
      head: version.hash(),
    })
  );
  const write = async (object) => {
    const hash = object.hash().toString();
    const filename = path.join(root, '.bit/objects', hash.slice(0, 2), hash.slice(2));
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, await object.compress());
    return filename;
  };
  await Promise.all([version, ...models].map(write));
  const index = {
    components: models.map((model) => ({
      id: { scope: model.scope, name: model.name },
      isSymlink: false,
      hash: model.hash().toString(),
    })),
    lanes: [],
  };
  await fs.writeFile(path.join(root, '.bit/index.json'), JSON.stringify(index));
  const targets = models.map((model) => ({ identity: model.id(), version: '1.0.0' }));
  return { root, version, models, index, targets, write };
}
test('status model batch reads canonical objects in index order and deduplicates Version reads', async (t) => {
  const { root, version, models, targets } = await fixture(t);
  const response = request(root, [...targets, { identity: 'qualification.status/missing', version: '1.0.0' }]);
  assert.equal(response.failed, false);
  assert.deepEqual(response.data.semantics, [
    Version.parse(version.toBuffer().toString(), version.hash().toString()).calculateHash().toString(),
  ]);
  assert.deepEqual(
    response.data.models,
    models.map((model) => JSON.parse(model.toBuffer().toString()))
  );
  assert.deepEqual(response.data.versions, [[version.hash().toString(), JSON.parse(version.toBuffer().toString())]]);
});
test('mutable Version bodies are reread and malformed compressed objects decline the entire batch', async (t) => {
  const { root, version, targets, write } = await fixture(t);
  assert.equal(request(root, targets).failed, false);
  version.log.message = 'changed under the same stable hash';
  const filename = await write(version);
  assert.equal(request(root, targets).data.versions[0][1].log.message, version.log.message);
  await fs.appendFile(filename, 'trailing bytes');
  const declined = request(root, targets);
  assert.equal(declined.failed, true);
  assert.equal(declined.data, undefined);
});
test('model index identity mismatches and symlinks decline without partial snapshots', async (t) => {
  const { root, index, targets } = await fixture(t);
  index.components[0].id.name = 'other';
  await fs.writeFile(path.join(root, '.bit/index.json'), JSON.stringify(index));
  assert.equal(request(root, targets).failed, true);
  index.components[0].id.name = 'component0';
  index.components[0].isSymlink = true;
  await fs.writeFile(path.join(root, '.bit/index.json'), JSON.stringify(index));
  assert.equal(request(root, targets).failed, true);
});

test('native stored Version semantics match canonical parsing, defaults and extension configuration', async (t) => {
  const { root, version, index, targets } = await fixture(t);
  index.components = index.components.slice(0, 1);
  await fs.writeFile(path.join(root, '.bit/index.json'), JSON.stringify(index));
  const { deflateSync } = require('node:zlib');
  const hash = version.hash().toString();
  const filename = path.join(root, '.bit/objects', hash.slice(0, 2), hash.slice(2));
  for (let i = 0; i < 128; i++) {
    const raw = JSON.parse(version.toBuffer().toString());
    raw.log.message = i % 2 ? false : 'message';
    raw.packageDependencies = i % 3 ? { beta: '^2', alpha: '^1' } : [null, false, 0, ''][i % 4];
    raw.overrides = i % 4 ? { devDependencies: { types: '1.0.0' } } : null;
    if (i % 2) delete raw.devDependencies;
    raw.dependencies = [
      { id: { scope: 'qualification.status', name: 'dep', version: i % 3 ? '1.0.0' : 'latest' }, relativePaths: [] },
    ];
    raw.extensions = [
      {
        name: 'teambit.dependencies/dependency-resolver',
        config: { z: i, __specific: true, a: { 2: 'two', 1: 'one' } },
        data: { ignoredForHash: i },
      },
      {
        extensionId: { scope: 'qualification.status', name: 'extension', version: i % 2 ? '2.0.0' : 'latest' },
        config: i % 3 ? { enabled: true } : '-',
        data: {},
      },
    ];
    if (i % 2) raw.extensions.reverse();
    const body = Buffer.from(JSON.stringify(raw));
    await fs.writeFile(filename, deflateSync(Buffer.concat([Buffer.from(`Version ${hash} ${body.length}\0`), body])));
    const expected = Version.parse(body.toString(), hash).calculateHash().toString();
    const actual = request(root, targets.slice(0, 1));
    assert.equal(actual.failed, false, `case ${i}`);
    assert.equal(actual.data.semantics[0], expected, `case ${i}: ${Version.parse(body.toString(), hash).id()}`);
  }
});

test('cached main status and merge distances match the actual Node history pipeline', async (t) => {
  const { root, models, index, targets, write } = await fixture(t);
  const { VersionHistory, Ref } = installed('@teambit/objects');
  const { getDivergeData } = installed('@teambit/component.snap-distance');
  index.components = index.components.slice(0, 1);
  await fs.writeFile(path.join(root, '.bit/index.json'), JSON.stringify(index));
  const model = models[0];
  const remoteFile = path.join(root, '.bit/refs/remotes', model.scope, 'main');
  await fs.mkdir(path.dirname(remoteFile), { recursive: true });
  const ref = (n) => new Ref(n.toString(16).padStart(40, '0'));
  const normalize = (distance) => ({
    sourceOnly: distance.snapsOnSourceOnly.map(String),
    targetOnly: distance.snapsOnTargetOnly.map(String),
    noCommon: !!distance.err,
    ...(distance.commonSnapBeforeDiverge ? { common: distance.commonSnapBeforeDiverge.toString() } : {}),
  });
  for (let i = 0; i < 64; i++) {
    const versions = Array.from({ length: 7 }, (_, n) => ({
      hash: ref(n + 1),
      parents: n ? [ref(i % 3 && n > 2 ? n - 1 : n)] : [],
    }));
    if (i % 4 === 0) versions[6].parents.push(ref(4));
    if (i % 3 === 0) versions[6].parents = [];
    if (i % 6 === 0) versions[6].unrelated = ref(2);
    if (i % 7 === 0) versions[6].squashed = [ref(3)];
    const history = new VersionHistory({ name: model.name, scope: model.scope, versions });
    await write(history);
    model.head = ref(3 + (i % 5));
    await write(model);
    const remote = i % 8 ? ref(i % 8) : null;
    await fs.writeFile(
      remoteFile,
      JSON.stringify(remote ? [{ id: { scope: model.scope, name: model.name }, head: remote.toString() }] : [])
    );
    const repo = {
      load: async (hash) => {
        assert.equal(hash.toString(), history.hash().toString());
        return history;
      },
      unmergedComponents: { getEntry: () => undefined },
    };
    // The workspace version uses the fixture's existing Version body; include
    // that detached ref in history without manufacturing a second body read.
    history.addFromVersionParents([{ hash: model.getRef('1.0.0'), parents: [ref(2)] }]);
    await write(history);
    const status = await getDivergeData({
      repo,
      modelComponent: model,
      sourceHead: model.getRef('1.0.0'),
      targetHead: remote,
      throws: false,
    });
    const merge = await getDivergeData({ repo, modelComponent: model, targetHead: remote, throws: false });
    const actual = request(root, targets.slice(0, 1), true);
    assert.equal(actual.failed, false, `case ${i}`);
    assert.deepEqual(
      actual.data.histories,
      [
        {
          identity: model.id(),
          remoteHead: remote?.toString() ?? null,
          status: normalize(status),
          merge: normalize(merge),
        },
      ],
      `case ${i}`
    );
  }
  await fs.writeFile(path.join(root, '.bit/unmerged.json'), JSON.stringify([{ unrelated: true }]));
  assert.equal(request(root, targets.slice(0, 1), true).failed, true);
});

test('missing history keeps population and writes on the canonical path', async (t) => {
  const { root, targets } = await fixture(t);
  const response = request(root, targets, true);
  assert.equal(response.failed, true);
  assert.equal(response.data, undefined);
  assert.equal(request(root, targets).failed, false);
});
