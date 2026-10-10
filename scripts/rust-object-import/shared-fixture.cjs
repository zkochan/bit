// Origin/cache scopes sharing model/history identities with intentionally different contents.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createFixture } = require('./scope-fixture.cjs');
async function createSharedFixture(cli, directory, first) {
  const load = createRequire(path.join(cli, 'package.json'));
  const { Scope } = load('@teambit/legacy.scope');
  const { Ref, Version, ModelComponent, VersionHistory } = load('@teambit/objects');
  const manifest = await createFixture(cli, directory, {
    components: 4,
    files: 1,
    bytes: 1024,
    versions: 8,
    overlap: 'local',
  });
  const originName = 'qualification.remote0',
    cacheName = 'qualification.cache';
  const origin = await Scope.load(path.join(directory, originName), false);
  const cachePath = path.join(directory, cacheName);
  await fs.mkdir(cachePath);
  const cache = await Scope.ensure(cachePath, cacheName);
  await cache.ensureDir();
  manifest.remotes[cacheName] = `file://${cachePath}`;
  const cacheIds = [],
    markers = [];
  manifest.firstHashes = [];
  manifest.cacheExtraRefs = [];
  for (const [id, expected] of Object.entries(manifest.components)) {
    const component = await origin.objects.load(new Ref(expected.hash));
    const base = await origin.objects.load(component.versions['1.0.0']);
    const second = await origin.objects.load(component.versions['1.0.1']);
    const extra = new Version({
      mainFile: base.mainFile,
      files: base.files,
      parents: [second.hash()],
      log: { message: 'cached branch', date: '1700002000000', username: 'cache', email: 'cache@example.invalid' },
    });
    extra._hash = extra.calculateHash().toString();
    const cached = ModelComponent.from({
      name: component.name,
      scope: component.scope,
      versions: { '1.0.0': base.hash(), '1.0.1': second.hash(), '9.0.9': extra.hash() },
      head: extra.hash(),
    });
    const history = new VersionHistory({
      name: component.name,
      scope: component.scope,
      versions: [base, second, extra].map((v) => ({ hash: v.hash(), parents: v.parents })),
      graphCompleteRefs: [base, second, extra].map((v) => v.hash().toString()),
    });
    const sources = await Promise.all(base.files.map((file) => origin.objects.load(file.file)));
    await cache.objects.writeObjectsToTheFS([...sources, base, second, extra, history, cached]);
    manifest.localHashes[extra.hash().toString()] = { type: 'Version' };
    manifest.cacheExtraRefs.push(extra.hash().toString());
    manifest.firstHashes.push(
      ...sources.map((source) => source.hash().toString()),
      ...(first === 'cache'
        ? [base, second, extra].map((v) => v.hash().toString())
        : Object.values(component.versions).map((ref) => ref.toString()))
    );
    cacheIds.push(`${id}@${extra.hash()}`);
    if (first === 'cache') {
      const keep = new Set([base.hash().toString(), second.hash().toString(), ...Object.keys(manifest.localHashes)]);
      expected.history.versions = Object.fromEntries(
        Object.entries(expected.history.versions).filter(([hash]) => keep.has(hash))
      );
      expected.history.versions[extra.hash().toString()] = [second.hash().toString()];
    }
    markers.push({
      hash: expected.history.hash,
      marker: first === 'cache' ? extra.hash().toString() : component.head.toString(),
    });
  }
  manifest.groupedIds = {
    [originName]: manifest.ids.map((id) => `${id}@${manifest.components[id].remoteHead}`),
    [cacheName]: cacheIds,
  };
  manifest.waitingRemote = first === 'cache' ? originName : cacheName;
  manifest.markers = markers;
  Scope.scopeCache = {};
  return manifest;
}
module.exports = { createSharedFixture };
