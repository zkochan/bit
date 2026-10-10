// Release assembly supports explicit artifacts and trusted, revision-pinned CI provisioning.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { targets } = require('./contract.cjs');
const { assemble } = require('./install-helper.cjs');
const { createRequire } = require('node:module');
const { provisionRelease } = require('./provision-release.cjs');

function assembleRelease(
  distribution,
  target,
  artifactDirectory = process.env.BIT_RUST_OBJECT_IMPORT_ARTIFACT_DIRECTORY
) {
  assert.ok(Object.hasOwn(targets, target), 'release assembly requires a supported target');
  if (!artifactDirectory) return undefined;
  const prefix = `bit-object-import-0.1.0-${target}-`;
  const archives = fs
    .readdirSync(artifactDirectory)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.tar.gz'));
  assert.equal(archives.length, 1, `exactly one object-import archive required for ${target}`);
  return assemble(distribution, path.join(artifactDirectory, archives[0]), target);
}

async function assembleTrustedRelease(distribution, target) {
  if (process.env.BIT_RUST_OBJECT_IMPORT_ARTIFACT_DIRECTORY) return assembleRelease(distribution, target);
  if (process.env.BIT_RUST_OBJECT_IMPORT_PROVISION === 'off') return undefined;
  let contract;
  try {
    const load = createRequire(path.resolve(distribution, 'package.json'));
    contract = path.join(path.dirname(load.resolve('@teambit/objects')), 'objects/rust-object-package.js');
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') return undefined;
    throw error;
  }
  if (!fs.existsSync(contract)) return undefined;
  // Distribution builds with the compiled native contract automatically provision in CI.
  if (!process.env.CI && process.env.BIT_RUST_OBJECT_IMPORT_PROVISION !== 'on') return undefined;
  const directory = await provisionRelease(target);
  try {
    return assembleRelease(distribution, target, directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
if (require.main === module) {
  assert.equal(process.argv.length, 4, 'expected distribution and target');
  assembleTrustedRelease(process.argv[2], process.argv[3])
    .then((destination) => {
      console.log(
        destination || 'No compiled native contract or provisioning disabled; keeping Node-only distribution'
      );
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
module.exports = { assembleRelease, assembleTrustedRelease };
