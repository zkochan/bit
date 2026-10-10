// Full compiled repository qualification; uses the same private graph as the HTTP command driver.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { installed, installedRoot } = require('./load-source.cjs');
const { createFixture, destination, seedDestination, verify } = require('./scope-fixture.cjs');
const { Scope } = installed('@teambit/legacy.scope');
const { Ref, VersionHistory } = installed('@teambit/objects');
const { LaneId } = installed('@teambit/lane-id');
const { ModelComponentMerger } = installed('@teambit/legacy.scope/dist/component-ops/model-components-merger.js');
const { MultipleComponentMerger } = installed('@teambit/legacy.scope/dist/component-ops/multiple-component-merger.js');
const { benchmarkGlobals } = require('../rust-dependency-analysis/command-workspace.cjs');
for (const overlap of ['origin', 'local', 'cached']) {
  test(`${overlap} overlap fixture verifies canonical merge and detects lost local history`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bit overlap fixture '));
    const oldGlobals = process.env.BIT_GLOBALS_DIR;
    process.env.BIT_GLOBALS_DIR = benchmarkGlobals(directory);
    t.after(async () => {
      if (oldGlobals === undefined) delete process.env.BIT_GLOBALS_DIR;
      else process.env.BIT_GLOBALS_DIR = oldGlobals;
      for (const key of Object.keys(Scope.scopeCache)) if (key.startsWith(directory)) delete Scope.scopeCache[key];
      await fs.rm(directory, { recursive: true, force: true });
    });
    const manifest = await createFixture(installedRoot, path.join(directory, 'remotes'), {
      components: 1,
      files: 1,
      bytes: 1024,
      versions: 3,
      overlap: overlap === 'cached' ? 'local' : overlap,
    });
    const target = path.join(directory, 'destination');
    await destination(installedRoot, target, manifest);
    await seedDestination(installedRoot, target, manifest);
    const scope = await Scope.load(target, false);
    const remote = await Scope.load(path.join(directory, 'remotes', 'qualification.remote0'), false);
    const expected = Object.values(manifest.components)[0];
    const incoming = await remote.objects.load(new Ref(expected.hash));
    const existing = await scope.objects.load(new Ref(expected.hash));
    let mergedComponent;
    if (overlap === 'cached') {
      expected.tags = Object.fromEntries(Object.entries(existing.versions).map(([tag, ref]) => [tag, ref.toString()]));
      expected.orphaned = {
        ...expected.orphaned,
        ...Object.fromEntries(
          Object.entries(incoming.versions)
            .filter(([tag]) => !existing.versions[tag])
            .map(([tag, ref]) => [tag, ref.toString()])
        ),
      };
      expected.remoteHead = undefined;
      [mergedComponent] = await new MultipleComponentMerger(
        { 'qualification.cache': [incoming] },
        scope.sources
      ).merge();
    } else {
      ({ mergedComponent } = await new ModelComponentMerger(existing, incoming, true, true).merge());
    }
    const history = await scope.objects.load(new Ref(expected.history.hash));
    history.merge(await remote.objects.load(new Ref(expected.history.hash)));
    const immutable = await Promise.all(
      Object.entries(manifest.hashes)
        .filter(([, value]) => ['Source', 'Version'].includes(value.type))
        .map(([hash]) => remote.objects.load(new Ref(hash)))
    );
    await scope.objects.writeObjectsToTheFS([...immutable, history, mergedComponent]);
    if (overlap !== 'cached') {
      mergedComponent.remoteHead = incoming.head;
      await scope.objects.remoteLanes.addEntriesFromModelComponents(LaneId.from('main', incoming.scope), [
        mergedComponent,
      ]);
      await scope.objects.writeRemoteLanes();
    }
    scope.objects.clearObjectsFromCache();
    delete Scope.scopeCache[target];
    assert.equal((await verify(installedRoot, target, manifest)).contentsAndModelsVerified, true);
    const reopened = await Scope.load(target, false);
    const stored = await reopened.objects.load(new Ref(expected.history.hash));
    const lost = Object.keys(manifest.localHashes)[0];
    const corrupted = new VersionHistory({
      name: stored.name,
      scope: stored.scope,
      versions: stored.versions.filter((v) => v.hash.toString() !== lost),
      graphCompleteRefs: stored.graphCompleteRefs,
    });
    await reopened.objects.writeObjectsToTheFS([corrupted]);
    reopened.objects.clearObjectsFromCache();
    delete Scope.scopeCache[target];
    await assert.rejects(verify(installedRoot, target, manifest), { code: 'ERR_ASSERTION' });
  });
}
