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
