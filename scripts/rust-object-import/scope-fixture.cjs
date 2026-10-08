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
      await scope.objects.writeObjectsToTheFS([
        ...sources.map(({ source }) => source),
        ...versions,
        history,
        component,
      ]);
      manifest.hashes[component.hash().toString()] = { type: 'Component' };
      manifest.hashes[history.hash().toString()] = { type: 'VersionHistory' };
      manifest.ids.push(`${scopeName}/${name}`);
      manifest.components[`${scopeName}/${name}`] = {
        hash: component.hash().toString(),
        head: component.head.toString(),
        tags: Object.fromEntries(Object.entries(tags).map(([tag, ref]) => [tag, ref.toString()])),
      };
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
async function verify(cliRoot, directory, manifest) {
  const load = createRequire(path.join(cliRoot, 'package.json'));
  const { Scope } = load('@teambit/legacy.scope');
  const { Ref } = load('@teambit/objects');
  const scope = await Scope.load(directory, false);
  try {
    const found = {};
    const models = {};
    for (const [hash, expected] of Object.entries(manifest.hashes)) {
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
module.exports = { createFixture, destination, verify };
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
