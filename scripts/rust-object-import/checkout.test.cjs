const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { root, source, installed, installedRoot } = require('./load-source.cjs');
const { createCheckoutFixture } = require('./checkout-qualification.cjs');
const compiled = process.env.BIT_TEST_CHECKOUT_COMPILED === '1';
const { applyVersion } = compiled
  ? require(path.join(path.dirname(installed.resolve('@teambit/checkout')), 'checkout-version.js'))
  : source('scopes/component/checkout/checkout-version.ts');
const { Scope } = installed('@teambit/legacy.scope');
const { Consumer } = installed('@teambit/legacy.consumer');
const { getRustCheckoutSourceDescriptor } = installed('@teambit/component.sources');
const { ComponentID } = installed('@teambit/component-id');
const { FileStatus } = installed('@teambit/component.modules.merge-helper');
const { SourceFile } = installed('@teambit/component.sources');
const helper =
  process.env.BIT_TEST_OBJECT_IMPORT ||
  path.join(root, 'native/target/debug/bit-object-import' + (process.platform === 'win32' ? '.exe' : ''));
async function setup(t, native) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-checkout-test-'));
  const previous = { flag: process.env.BIT_RUST_CLIENT_VCS, helper: process.env.BIT_RUST_OBJECT_IMPORT };
  process.env.BIT_RUST_CLIENT_VCS = native ? 'on' : 'off';
  process.env.BIT_RUST_OBJECT_IMPORT = helper;
  t.after(async () => {
    for (const [key, value] of [
      ['BIT_RUST_CLIENT_VCS', previous.flag],
      ['BIT_RUST_OBJECT_IMPORT', previous.helper],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    Scope.scopeCache = {};
    await fs.rm(directory, { recursive: true, force: true });
  });
  const fixture = await createCheckoutFixture(installedRoot, path.join(directory, 'scope'));
  const scope = await Scope.ensure(path.join(directory, 'scope'), 'qualification.checkout');
  const id = ComponentID.fromString(`${fixture.id}@1.0.0`);
  const model = await scope.getModelComponent(id);
  const current = await model.toConsumerComponent('1.0.1', 'qualification.checkout', scope.objects);
  const componentRoot = path.join(directory, 'component');
  await fs.mkdir(componentRoot);
  for (const file of current.files) {
    file.updatePaths({ newBase: componentRoot });
    await fs.writeFile(file.path, file.contents);
  }
  current.componentMap = { rootDir: 'component' };
  const bitmapUpdates = [];
  const consumer = {
    scope,
    bitMap: {
      getComponentIdIfExist: () => current.id,
      updateComponentId: (value) => bitmapUpdates.push(value.toString()),
    },
    loadComponentFromModelImportIfNeeded: Consumer.prototype.loadComponentFromModelImportIfNeeded,
  };
  return {
    directory,
    fixture,
    scope,
    model,
    id,
    current,
    consumer,
    bitmapUpdates,
    componentRoot,
  };
}

test('clean applyVersion preserves statuses, removals and native/canonical model metadata', async (t) => {
  const results = [];
  for (const native of [false, true]) {
    const state = await setup(t, native);
    const result = await applyVersion(state.consumer, state.id, state.current, undefined, {});
    assert.equal(result.applyVersionResult.filesStatus['added.js'], FileStatus.removed);
    assert.equal(result.applyVersionResult.filesStatus['case.js'], FileStatus.removed);
    assert.equal(result.applyVersionResult.filesStatus['index.js'], FileStatus.updated);
    assert.equal(result.applyVersionResult.filesStatus['removed.js'], FileStatus.updated);
    await assert.rejects(fs.lstat(path.join(state.componentRoot, 'added.js')), { code: 'ENOENT' });
    if (process.platform !== 'win32')
      await assert.rejects(fs.lstat(path.join(state.componentRoot, 'case.js')), { code: 'ENOENT' });
    assert.ok(await fs.stat(path.join(state.componentRoot, 'index.js')));
    if (native)
      assert.ok(
        result.component.files.every((file) => getRustCheckoutSourceDescriptor(file)),
        'native source plan must preserve deferred source provenance'
      );
    results.push({
      statuses: result.applyVersionResult.filesStatus,
      id: result.component.id.toString(),
      files: result.component.files
        .map((file) => ({ relative: file.relative, contents: file.contents.toString('hex'), test: file.test }))
        .sort((a, b) => a.relative.localeCompare(b.relative)),
      mainFile: result.component.mainFile,
      extensions: result.component.extensions.toConfigObject(),
    });
    assert.deepEqual(state.bitmapUpdates, []);
  }
  assert.deepEqual(results[0], results[1]);
});

test('force ours skips Source loading and removals while updating bitmap identity', async (t) => {
  const state = await setup(t, true);
  state.consumer.loadComponentFromModelImportIfNeeded = () => assert.fail('ours must not load target component');
  state.scope.getModelComponent = () => assert.fail('ours must not enter native model plan');
  const result = await applyVersion(state.consumer, state.id, state.current, undefined, { forceOurs: true });
  assert.equal(result.component, undefined);
  assert.deepEqual(state.bitmapUpdates, [state.id.toString()]);
  assert.ok(Object.values(result.applyVersionResult.filesStatus).every((status) => status === FileStatus.unchanged));
  assert.ok(await fs.stat(path.join(state.componentRoot, 'added.js')));
});

test('live workspace-root bitmap is protected from checked-out model removals', async (t) => {
  const state = await setup(t, true);
  const bitmapPath = path.join(state.componentRoot, '.bitmap');
  await fs.writeFile(bitmapPath, 'live map');
  state.current.files.push(
    new SourceFile({ base: state.componentRoot, path: bitmapPath, contents: Buffer.from('versioned map') })
  );
  state.current.componentMap.rootDir = '.';
  const result = await applyVersion(state.consumer, state.id, state.current, undefined, {});
  assert.equal(await fs.readFile(bitmapPath, 'utf8'), 'live map');
  assert.equal(result.applyVersionResult.filesStatus['.bitmap'], undefined);
});

for (const kind of ['missing', 'corrupt']) {
  test(`${kind} Source falls back before checkout can delete current files`, async (t) => {
    const state = await setup(t, true);
    const hash = state.fixture.sourceRefs['0/removed.js'];
    const filename = path.join(state.scope.objects.getPath(), hash.slice(0, 2), hash.slice(2));
    if (kind === 'missing') await fs.rm(filename);
    else await fs.writeFile(filename, 'not a compressed object');
    let nativeError;
    await assert.rejects(applyVersion(state.consumer, state.id, state.current, undefined, {}), (error) => {
      nativeError = error;
      return true;
    });
    assert.ok(await fs.stat(path.join(state.componentRoot, 'added.js')), 'failure must precede deletion');
    process.env.BIT_RUST_CLIENT_VCS = 'off';
    let canonicalError;
    await assert.rejects(applyVersion(state.consumer, state.id, state.current, undefined, {}), (error) => {
      canonicalError = error;
      return true;
    });
    assert.deepEqual(
      { name: nativeError.constructor.name, message: nativeError.message },
      { name: canonicalError.constructor.name, message: canonicalError.message }
    );
    if (kind === 'missing') assert.match(nativeError.message, /Source object is missing from the local scope/);
  });
}

test('custom consumer model loading remains canonical and preserves Source transformations', async (t) => {
  const state = await setup(t, true);
  let called = 0;
  state.consumer.loadComponentFromModelImportIfNeeded = async function (id) {
    assert.equal(this, state.consumer);
    called++;
    const component = await state.model.toConsumerComponent(id.version, 'qualification.checkout', state.scope.objects);
    component.files.find((file) => file.relative === 'index.js').contents = Buffer.from('custom loader contents\n');
    return component;
  };
  const result = await applyVersion(state.consumer, state.id, state.current, undefined, {});
  assert.equal(called, 1);
  assert.equal(
    result.component.files.find((file) => file.relative === 'index.js').contents.toString(),
    'custom loader contents\n'
  );
  assert.ok(result.component.files.every((file) => !getRustCheckoutSourceDescriptor(file)));
});
