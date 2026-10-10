// Deterministic real bare scopes; no network services, mocks or shared scope writes.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
async function createFixture(cliRoot, directory, options) {
  const load = createRequire(path.join(cliRoot, 'package.json'));
  const { Scope } = load('@teambit/legacy.scope');
  const { Source, Version, ModelComponent, VersionHistory } = load('@teambit/objects');
  const manifest = { schemaVersion: 1, options, remotes: {}, ids: [], hashes: {}, components: {}, sourceBytes: 0 };
  let ordinal = 0;
  for (let remoteIndex = 0; remoteIndex < (options.remotes || 1); remoteIndex++) {
    const scopeName = `qualification.remote${remoteIndex}`;
    const remotePath = path.join(directory, scopeName);
    await fs.mkdir(remotePath, { recursive: true });
    const scope = await Scope.ensure(remotePath, scopeName);
    await scope.ensureDir();
    manifest.remotes[scopeName] = `file://${remotePath}`;
    for (let componentIndex = 0; componentIndex < options.components; componentIndex++) {
      const name = `component-${componentIndex}`;
      const sources = [];
      for (let fileIndex = 0; fileIndex < options.files; fileIndex++) {
        const size = options.bytes;
        let contents;
        if (options.binary && fileIndex > 0) {
          contents = Buffer.alloc(size);
          let state = 12345 + ordinal;
          for (let offset = 0; offset < size; offset++) {
            state ^= state << 13;
            state ^= state >>> 17;
            state ^= state << 5;
            contents[offset] = state & 255;
          }
        } else {
          contents = Buffer.alloc(options.binary ? 256 : size, 97);
          contents.write(`/* ${ordinal} `);
          contents.write(' */\nexport default 1;\n', contents.length - 22);
        }
        ordinal++;
        const source = Source.from(contents);
        sources.push({
          source,
          relativePath: fileIndex === 0 ? 'index.js' : `file-${fileIndex}.${options.binary ? 'bin' : 'js'}`,
        });
        manifest.sourceBytes += contents.length;
        manifest.hashes[source.hash().toString()] = {
          type: 'Source',
          contentSha256: createHash('sha256').update(contents).digest('hex'),
          bytes: contents.length,
        };
      }
      const versions = [];
      for (let versionIndex = 0; versionIndex < (options.versions || 2); versionIndex++) {
        const version = new Version({
          mainFile: 'index.js',
          files: sources.map(({ source, relativePath }) => ({
            name: path.basename(relativePath),
            relativePath,
            test: false,
            file: source.hash(),
          })),
          log: {
            message: `version ${versionIndex}`,
            date: String(1700000000000 + versionIndex),
            username: 'fixture',
            email: 'fixture@example.invalid',
          },
          parents: versions.length ? [versions.at(-1).hash()] : [],
        });
        version._hash = version.calculateHash().toString();
        version.validate();
        versions.push(version);
        manifest.hashes[version.hash().toString()] = { type: 'Version' };
      }
      const tags = Object.fromEntries(versions.map((version, index) => [`1.0.${index}`, version.hash()]));
      const component = ModelComponent.from({ name, scope: scopeName, versions: tags, head: versions.at(-1).hash() });
      const history = new VersionHistory({
        name,
        scope: scopeName,
        versions: versions.map((v) => ({ hash: v.hash(), parents: v.parents })),
        graphCompleteRefs: versions.map((v) => v.hash().toString()),
      });
      let expected = {
        hash: component.hash().toString(),
        head: component.head.toString(),
        tags: Object.fromEntries(Object.entries(tags).map(([tag, ref]) => [tag, ref.toString()])),
      };
      if (options.overlap) {
        assert.ok(['origin', 'local', 'conflict'].includes(options.overlap));
        manifest.seedObjects ||= [];
        manifest.localHashes ||= {};
        const localVersions = [0, 1, 2].map((index) => {
          const version = new Version({
            mainFile: 'index.js',
            files: versions[0].files,
            log: {
              message: `local ${index}`,
              date: String(1700001000000 + index),
              username: 'local',
              email: 'local@example.invalid',
            },
            parents: [versions[0].hash()],
          });
          version._hash = version.calculateHash().toString();
          version.validate();
          return version;
        });
        const conflict = options.overlap === 'conflict';
        const local = options.overlap === 'local' || conflict;
        const state = local
          ? { versions: { '1.0.90': { local: true }, ...(conflict ? { '1.0.0': { local: true } } : {}) } }
          : {};
        const seed = ModelComponent.from({
          name,
          scope: scopeName,
          versions: {
            '1.0.0': local && !conflict ? versions[0].hash() : localVersions[0].hash(),
            '1.0.90': localVersions[1].hash(),
          },
          orphanedVersions: { '1.0.91': localVersions[2].hash() },
          state,
          head: local ? localVersions[1].hash() : versions[0].hash(),
        });
        seed.validate();
        const seedHistory = new VersionHistory({
          name,
          scope: scopeName,
          versions: [versions[0], ...localVersions].map((v) => ({ hash: v.hash(), parents: v.parents })),
          graphCompleteRefs: localVersions.map((v) => v.hash().toString()),
        });
        for (const object of [versions[0], ...localVersions, seedHistory, seed]) {
          manifest.seedObjects.push((await object.compress()).toString('base64'));
        }
        for (const version of localVersions) manifest.localHashes[version.hash().toString()] = { type: 'Version' };
        const orphaned = { '1.0.91': localVersions[2].hash().toString() };
        const expectedTags = conflict
          ? Object.fromEntries(Object.entries(seed.versions).map(([tag, ref]) => [tag, ref.toString()]))
          : { ...expected.tags };
        if (local) expectedTags['1.0.90'] = localVersions[1].hash().toString();
        else orphaned['1.0.90'] = localVersions[1].hash().toString();
        expected = {
          ...expected,
          head: local ? seed.head.toString() : expected.head,
          tags: expectedTags,
          orphaned,
          state,
          remoteHead: conflict ? undefined : component.head.toString(),
          history: {
            hash: history.hash().toString(),
            versions: Object.fromEntries(
              [...versions, ...localVersions].map((v) => [v.hash().toString(), v.parents.map((p) => p.toString())])
            ),
            retainedCompleteRefs: seedHistory.graphCompleteRefs,
          },
        };
      }
      await scope.objects.writeObjectsToTheFS([
        ...sources.map(({ source }) => source),
        ...versions,
        history,
        component,
      ]);
      manifest.hashes[component.hash().toString()] = { type: 'Component' };
      manifest.hashes[history.hash().toString()] = { type: 'VersionHistory' };
      manifest.ids.push(`${scopeName}/${name}`);
      manifest.components[`${scopeName}/${name}`] = expected;
    }
  }
  Scope.scopeCache = {};
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}
async function destination(cliRoot, directory, manifest) {
  const load = createRequire(path.join(cliRoot, 'package.json'));
  const { Scope } = load('@teambit/legacy.scope');
  const scope = await Scope.ensure(directory, 'qualification.destination');
  await scope.ensureDir();
  scope.scopeJson.remotes = manifest.remotes;
  await scope.scopeJson.write();
  return scope;
}
async function seedDestination(cliRoot, directory, manifest) {
  if (!manifest.seedObjects) return;
  const load = createRequire(path.join(cliRoot, 'package.json'));
  const { Scope } = load('@teambit/legacy.scope');
  const { BitObject } = load('@teambit/objects');
  const scope = await Scope.load(directory, false);
  try {
    const objects = await Promise.all(
      manifest.seedObjects.map((buffer) => BitObject.parseObject(Buffer.from(buffer, 'base64')))
    );
    await scope.objects.writeObjectsToTheFS(objects);
  } finally {
    scope.objects.clearObjectsFromCache();
    delete Scope.scopeCache[scope.path];
  }
}
async function verify(cliRoot, directory, manifest) {
  const load = createRequire(path.join(cliRoot, 'package.json'));
  const { Scope } = load('@teambit/legacy.scope');
  const { Ref } = load('@teambit/objects');
  const scope = await Scope.load(directory, false);
  try {
    const found = {};
    const models = {};
    for (const [hash, expected] of Object.entries({ ...manifest.hashes, ...manifest.localHashes })) {
      const obj = await scope.objects.load(new Ref(hash));
      assert.ok(obj, `missing ${expected.type} ${hash}`);
      assert.equal(obj.getType(), expected.type);
      if (expected.type === 'Source') {
        assert.equal(createHash('sha256').update(obj.contents).digest('hex'), expected.contentSha256);
        assert.equal(obj.contents.length, expected.bytes);
        assert.equal(obj.hash().toString(), hash);
      }
      found[hash] = obj.getType();
      if (expected.type !== 'Source') models[hash] = obj.toObject();
    }
    for (const [id, expected] of Object.entries(manifest.components)) {
      const component = await scope.objects.load(new Ref(expected.hash));
      assert.equal(component.head.toString(), expected.head);
      assert.deepEqual(
        Object.fromEntries(Object.entries(component.versions).map(([tag, ref]) => [tag, ref.toString()])),
        expected.tags
      );
      if (expected.history) {
        const refs = (values) => Object.fromEntries(Object.entries(values).map(([tag, ref]) => [tag, ref.toString()]));
        assert.deepEqual(refs(component.orphanedVersions), expected.orphaned);
        assert.deepEqual(component.state, expected.state);
        const history = await scope.objects.load(new Ref(expected.history.hash));
        assert.deepEqual(
          Object.fromEntries(history.versions.map((v) => [v.hash.toString(), v.parents.map((p) => p.toString())])),
          expected.history.versions
        );
        for (const ref of expected.history.retainedCompleteRefs)
          assert.ok(history.graphCompleteRefs.includes(ref), 'local complete-history marker lost');
        const { LaneId } = load('@teambit/lane-id');
        const remote = await scope.objects.remoteLanes.getRef(
          LaneId.from('main', component.scope),
          component.toComponentId()
        );
        assert.equal(remote?.toString(), expected.remoteHead, 'remote head must track incoming origin');
      }
      assert.ok(scope.objects.scopeIndex.find(expected.hash), `component not indexed: ${id}`);
    }
    return {
      count: Object.keys(found).length,
      contentsAndModelsVerified: true,
      modelsSha256: createHash('sha256').update(JSON.stringify(models)).digest('hex'),
    };
  } finally {
    scope.objects.clearObjectsFromCache();
    delete Scope.scopeCache[scope.path];
  }
}
module.exports = { createFixture, destination, seedDestination, verify };
if (require.main === module)
  (async () => {
    const [cliRoot, directory] = process.argv.slice(2);
    await fs.mkdir(directory, { recursive: true });
    const manifest = await createFixture(cliRoot, path.join(directory, 'remotes'), {
      components: 2,
      files: 2,
      bytes: 1024,
      versions: 2,
      remotes: 2,
    });
    await destination(cliRoot, path.join(directory, 'destination'), manifest);
    console.log(directory);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
