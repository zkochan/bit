// Exercise the compiled artifact-import API with genuine remote scopes and complete compressed-byte readback.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const { createFixture, destination } = require('./scope-fixture.cjs');
const { benchmarkGlobals } = require('../rust-dependency-analysis/command-workspace.cjs');
(async () => {
  const cli = path.resolve(process.argv[2]);
  const helper = path.resolve(process.argv[3]);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-inventory-import-'));
  process.env.BIT_GLOBALS_DIR = benchmarkGlobals(temporary);
  process.env.BIT_RUST_OBJECT_IMPORT = helper;
  const provenance = JSON.parse(await fs.readFile(path.join(cli, '.bit-object-import-build.json')));
  for (const file of provenance.compiledModules) {
    assert.equal(
      createHash('sha256')
        .update(await fs.readFile(path.join(cli, 'node_modules/@teambit', file.path)))
        .digest('hex'),
      file.sha256
    );
  }
  const load = createRequire(path.join(cli, 'package.json'));
  const inventory = load(path.join(cli, 'node_modules/@teambit/objects/dist/objects/rust-object-inventory.js'));
  const original = inventory.nativeObjectExists;
  const batches = [];
  inventory.nativeObjectExists = async (...args) => {
    const result = await original(...args);
    if (result) batches.push({ requested: args[1].length, existing: result.filter(Boolean).length });
    return result;
  };
  const { Ref, Repository } = load('@teambit/objects');
  const manifest = await createFixture(cli, path.join(temporary, 'remotes'), {
    components: 1,
    files: 2048,
    bytes: 128,
    versions: 1,
  });
  const hashes = Object.entries(manifest.hashes)
    .filter(([, object]) => object.type === 'Source')
    .map(([hash]) => hash);
  const remoteName = Object.keys(manifest.remotes)[0];
  const remote = await Repository.load({
    scopePath: path.join(temporary, 'remotes', remoteName),
    scopeJson: { name: remoteName },
  });
  const scope = await destination(cli, path.join(temporary, 'destination'), manifest);
  const grouped = { [remoteName]: [...hashes, hashes[0]] };
  const readback = async () => {
    for (const hash of hashes)
      assert.deepEqual(await scope.objects.loadRaw(new Ref(hash)), await remote.loadRaw(new Ref(hash)));
  };
  await scope.scopeImporter.importManyObjects(grouped, 'inventory qualification');
  await readback();
  await scope.scopeImporter.importManyObjects(grouped, 'inventory repeated qualification');
  await fs.unlink(scope.objects.objectPath(new Ref(hashes[0])));
  await scope.scopeImporter.importManyObjects(grouped, 'inventory repair qualification');
  await readback();
  assert.deepEqual(batches, [
    { requested: 2048, existing: 0 },
    { requested: 2048, existing: 2048 },
    { requested: 2048, existing: 2047 },
  ]);
  process.env.BIT_RUST_OBJECT_IMPORT = path.join(temporary, 'missing-helper');
  await fs.unlink(scope.objects.objectPath(new Ref(hashes[1])));
  await scope.scopeImporter.importManyObjects(grouped, 'inventory fallback qualification');
  await readback();
  console.log(
    JSON.stringify({
      sourcesVerified: hashes.length,
      batches,
      repeatedImport: true,
      deletedObjectRepair: true,
      missingHelperFallback: true,
    })
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
