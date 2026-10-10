const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const trace = path.join(__dirname, 'import-trace.cjs');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bit-import-trace-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const metrics = path.join(directory, 'metrics.json');
  const module = path.join(directory, 'objects-fixture.cjs');
  fs.writeFileSync(
    module,
    `
    class ObjectsWritable {
      async writeObjectToFs(object) { if (object.error) throw object.error; return object.value; }
    }
    class ObjectFetcher { async fetchFromRemoteAndWrite(value) { return value; } }
    module.exports = { ObjectsWritable, ObjectFetcher };
  `
  );
  return { directory, metrics, module };
}
function execute(files, code, env = {}) {
  const childEnv = { ...process.env, BIT_IMPORT_TRACE: files.metrics };
  delete childEnv.BIT_IMPORT_TRACE_OWNER;
  Object.assign(childEnv, env);
  const run = spawnSync(process.execPath, ['--require', trace, '-e', code], { encoding: 'utf8', env: childEnv });
  assert.equal(run.status, 0, run.stderr);
  return fs.existsSync(files.metrics) ? JSON.parse(fs.readFileSync(files.metrics)) : undefined;
}
test('diagnostic wrapping preserves async values/error identity and counts repeated module loads once', (t) => {
  const files = fixture(t);
  const metrics = execute(
    files,
    `
    const assert = require('node:assert/strict');
    const { ObjectsWritable } = require(${JSON.stringify(files.module)});
    require(${JSON.stringify(files.module)});
    (async () => {
      const object = new ObjectsWritable();
      assert.equal(await object.writeObjectToFs({ buffer: Buffer.from('data'), value: 42 }), 42);
      const error = new Error('original error');
      await assert.rejects(object.writeObjectToFs({ buffer: Buffer.alloc(0), error }), actual => actual === error);
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `,
    { BIT_IMPORT_TRACE_OWNER: String(process.pid) }
  );
  // A non-owner must not produce a misleading empty or partial trace.
  assert.equal(metrics, undefined);
  const actual = execute(
    files,
    `
    require(${JSON.stringify(trace)});
    const { ObjectsWritable } = require(${JSON.stringify(files.module)});
    (async () => {
      const object = new ObjectsWritable();
      const assert = require('node:assert/strict');
      assert.equal(await object.writeObjectToFs({ buffer: Buffer.from('data'), value: 42 }), 42);
      const error = new Error('original error');
      await assert.rejects(object.writeObjectToFs({ buffer: Buffer.alloc(0), error }), actual => actual === error);
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `
  );
  assert.equal(actual.stages.streamObjectProcessing.calls, 2);
  assert.equal(actual.receivedObjects, 1);
  assert.equal(actual.receivedCompressedBytes, 4);
});
test('forked analytics-style children inherit owner and cannot overwrite the command trace', (t) => {
  const files = fixture(t);
  const child = path.join(files.directory, 'child.cjs');
  fs.writeFileSync(child, `process.on('disconnect',()=>{});`);
  const metrics = execute(
    files,
    `
    const { ObjectsWritable } = require(${JSON.stringify(files.module)});
    new ObjectsWritable().writeObjectToFs({ buffer: Buffer.from('data') }).then(() => {
      const child = require('node:child_process').fork(${JSON.stringify(child)}, [], { stdio: 'ignore' });
      child.disconnect();
    });
  `
  );
  assert.equal(metrics.receivedObjects, 1);
  assert.equal(metrics.stages.streamObjectProcessing.calls, 1);
});
test('production tar diagnostics preserve result/error identity and distinguish native from fallback operations', (t) => {
  const files = fixture(t);
  const module = path.join(files.directory, 'rust-tar-fixture.cjs');
  fs.writeFileSync(
    module,
    `module.exports = {
    async importTarStream(value) { if (value instanceof Error) throw value; return value; },
    async readTarBatches(value) { return value; },
    async readProgressiveTarBatches(value) { return value; }
  };`
  );
  const actual = execute(
    files,
    `
    const assert = require('node:assert/strict');
    const api = require(${JSON.stringify(module)});
    (async () => {
      const result = {objects:5,nativeSources:4,fallback:false};
      assert.equal(await api.importTarStream(result),result);
      await api.importTarStream({objects:2,nativeSources:0,fallback:true});
      const error = new Error('original tar error');
      await assert.rejects(api.importTarStream(error),value=>value===error);
      await api.readTarBatches({batches:3});
      await api.readProgressiveTarBatches({batches:2});
    })().catch(error=>{console.error(error);process.exitCode=1;});
  `
  );
  assert.deepEqual(actual.tar, { operations: 2, objects: 7, nativeSources: 4, fallbacks: 1, batches: 5 });
  assert.equal(actual.stages.nativeTarIntake.calls, 3);
  assert.equal(actual.stages.nativeTarProtocol.calls, 2);
  assert.equal(Object.keys(actual.modules).length, 1);
});

test('tar intake inflation attribution separates later canonical repository reads', (t) => {
  const files = fixture(t);
  const module = path.join(files.directory, 'objects-parse-fixture.cjs');
  fs.writeFileSync(
    module,
    `module.exports = { BitObject: {
    async parseObjectWithSize(bytes, filename) {
      return { object: { getType: () => 'Version' } };
    }
  } };`
  );
  const actual = execute(
    files,
    `
    const { BitObject } = require(${JSON.stringify(module)});
    (async () => {
      await BitObject.parseObjectWithSize(Buffer.alloc(0));
      await BitObject.parseObjectWithSize(Buffer.alloc(0), '/repository/objects/hash');
    })().catch(error=>{console.error(error);process.exitCode=1;});
  `
  );
  assert.deepEqual(actual.inflation, { incoming: 1, repository: 1 });
  assert.equal(actual.stages.legacyParse.calls, 2);
  assert.deepEqual(actual.objectTypes, { Version: 2 });
});

test('fine merge/index diagnostics preserve synchronous values/errors and count policy work separately', (t) => {
  const files = fixture(t);
  fs.writeFileSync(
    files.module,
    `
    class ScopeIndex { addMany(value) { if(value instanceof Error) throw value; return value; } async write() { return 7; } }
    class ModelComponentMerger { async merge() { return 9; } }
    class VersionHistory { merge(value) { return value; } }
    class SourceRepository { async _findComponent(value) { return value; } }
    class Repository { async load(value) { return value; } }
    module.exports = { ScopeIndex, ModelComponentMerger, VersionHistory, SourceRepository, Repository };
  `
  );
  const actual = execute(
    files,
    `
    const assert=require('node:assert/strict');
    const {ScopeIndex,ModelComponentMerger,VersionHistory,SourceRepository,Repository}=require(${JSON.stringify(files.module)});
    (async()=>{
      const sources=new SourceRepository(), repo=new Repository();
      assert.equal(await sources._findComponent(undefined),undefined);
      assert.equal(await sources._findComponent(42),42);
      assert.equal(await repo.load(undefined),undefined);
      assert.equal(await repo.load(42),42);
      const index=new ScopeIndex();
      assert.equal(index.addMany(false),false);
      const error=new Error('index failure');
      assert.throws(()=>index.addMany(error), actual=>actual===error);
      assert.equal(await index.write(),7);
      assert.equal(await new ModelComponentMerger().merge(),9);
      const input={versions:[]};assert.equal(new VersionHistory().merge(input),input);
    })().catch(error=>{console.error(error);process.exitCode=1;});
  `
  );
  assert.deepEqual(actual.lookupResults, { repository: { found: 1, missing: 1 }, component: { found: 1, missing: 1 } });
  assert.equal(actual.stages.scopeIndexAdd.calls, 2);
  assert.equal(actual.stages.scopeIndexWrite.calls, 1);
  assert.equal(actual.stages.modelComponentMergePolicy.calls, 1);
  assert.equal(actual.stages.versionHistoryMergePolicy.calls, 1);
});

test('CPU profile belongs to the command and forked children cannot overwrite it', (t) => {
  const files = fixture(t);
  const profile = path.join(files.directory, 'command.cpuprofile');
  const preload = path.join(__dirname, 'import-cpu-profile.cjs');
  const child = path.join(files.directory, 'child.cjs');
  fs.writeFileSync(
    child,
    'function childOnlyWork(){const end=Date.now()+50;while(Date.now()<end){Math.sqrt(Math.random());}} childOnlyWork();'
  );
  const env = { ...process.env, BIT_IMPORT_CPU_PROFILE: profile };
  delete env.BIT_IMPORT_CPU_PROFILE_OWNER;
  const run = spawnSync(
    process.execPath,
    [
      '--require',
      preload,
      '-e',
      `
    function owningCommandWork(){const end=Date.now()+100;while(Date.now()<end){Math.sqrt(Math.random());}}
    owningCommandWork();
    require('node:child_process').fork(${JSON.stringify(child)},[],{stdio:'ignore'});
  `,
    ],
    { env, encoding: 'utf8' }
  );
  assert.equal(run.status, 0, run.stderr);
  const actual = JSON.parse(fs.readFileSync(profile));
  assert.ok(actual.samples.length);
  assert.equal(actual.samples.length, actual.timeDeltas.length);
  assert.ok(actual.nodes.some((node) => node.callFrame.functionName === 'owningCommandWork'));
  assert.ok(!actual.nodes.some((node) => node.callFrame.functionName === 'childOnlyWork'));
});
