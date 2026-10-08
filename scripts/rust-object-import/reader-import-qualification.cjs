// Exercise compiled batch-read/header APIs in genuine import scopes. Evidence stays outside Git.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { createFixture, destination } = require('./scope-fixture.cjs');
const { benchmarkGlobals } = require('../rust-dependency-analysis/command-workspace.cjs');
(async () => {
  const cli = path.resolve(process.argv[2]);
  const helper = path.resolve(process.argv[3]);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-read-import-'));
  process.env.BIT_GLOBALS_DIR = benchmarkGlobals(temporary);
  const provenance = JSON.parse(await fs.readFile(path.join(cli, '.bit-object-import-build.json')));
  for (const file of provenance.compiledModules)
    assert.equal(
      createHash('sha256')
        .update(await fs.readFile(path.join(cli, 'node_modules/@teambit', file.path)))
        .digest('hex'),
      file.sha256
    );
  const load = createRequire(path.join(cli, 'package.json'));
  const { Ref, Repository } = load('@teambit/objects');
  const reader = load(path.join(cli, 'node_modules/@teambit/objects/dist/objects/rust-object-reader.js'));
  const stages = { reads: [], headers: [], directories: [] };
  const directory = load(path.join(cli, 'node_modules/@teambit/objects/dist/objects/rust-object-directory.js'));
  const originalDirectory = directory.nativeObjectDirectory;
  directory.nativeObjectDirectory = async (...args) => {
    const result = await originalDirectory(...args);
    if (result) stages.directories.push({ headers: args[1] === true, native: result.length });
    return result;
  };
  for (const [name, stage] of [
    ['nativeObjectBuffers', 'reads'],
    ['nativeObjectHeaders', 'headers'],
  ]) {
    const original = reader[name];
    reader[name] = async (...args) => {
      const result = await original(...args);
      if (result)
        stages[stage].push({ requested: args[1].length, native: result.filter((value) => value !== undefined).length });
      return result;
    };
  }
  process.env.BIT_RUST_OBJECT_IMPORT = 'off';
  const manifest = await createFixture(cli, path.join(temporary, 'remotes'), {
    components: 1,
    files: 2048,
    bytes: 128,
    versions: 1,
  });
  const remoteName = Object.keys(manifest.remotes)[0];
  const hashes = Object.entries(manifest.hashes)
    .filter(([, object]) => object.type === 'Source')
    .map(([hash]) => hash);
  const refs = hashes.map((hash) => new Ref(hash));
  const remote = await Repository.load({
    scopePath: path.join(temporary, 'remotes', remoteName),
    scopeJson: { name: remoteName },
  });
  const expected = await remote.loadManyRaw(refs);
  const canonicalHeaders = await remote.listObjectsWithType();
  process.env.BIT_RUST_OBJECT_IMPORT = helper;
  assert.deepEqual(await remote.loadManyRaw(refs), expected);
  // Glob traversal order can differ between calls; per-request ordering is covered separately.
  const normalize = (inventory) => ({
    objects: inventory.objects.toSorted((a, b) => a.ref.toString().localeCompare(b.ref.toString())),
    unreadable: inventory.unreadable.map((ref) => ref.toString()).sort(),
  });
  assert.deepEqual(normalize(await remote.listObjectsWithType()), normalize(canonicalHeaders));
  assert.ok(stages.reads.some((stage) => stage.native === 2048));
  assert.ok(
    stages.headers.some((stage) => stage.native === Object.keys(manifest.hashes).length) ||
      stages.directories.some((stage) => stage.headers && stage.native === Object.keys(manifest.hashes).length)
  );
  const scope = await destination(cli, path.join(temporary, 'destination'), manifest);
  await scope.scopeImporter.importManyObjects({ [remoteName]: hashes }, 'batched read qualification');
  assert.deepEqual(await scope.objects.loadManyRaw(refs), expected);
  await scope.scopeImporter.importManyObjects({ [remoteName]: hashes }, 'batched read repeated qualification');
  await fs.unlink(scope.objects.objectPath(refs[1]));
  const found = await scope.objects.loadManyRawIgnoreMissing([...refs, refs[0]]);
  assert.equal(found.length, refs.length);
  assert.equal(found.at(-1).ref, refs[0]);
  await assert.rejects(scope.objects.loadManyRaw(refs), { code: 'ENOENT' });
  await scope.scopeImporter.importManyObjects({ [remoteName]: hashes }, 'batched read repair qualification');
  process.env.BIT_RUST_OBJECT_IMPORT = path.join(temporary, 'missing-helper');
  assert.deepEqual(await scope.objects.loadManyRaw(refs), expected);
  assert.equal(stages.reads.filter((stage) => stage.native === 2048).length >= 2, true);
  console.log(
    JSON.stringify({
      sourcesVerified: refs.length,
      stages,
      canonicalHeaderParity: true,
      missingObjectErrors: true,
      repeatedImport: true,
      deletionRepair: true,
      missingHelperFallback: true,
    })
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
