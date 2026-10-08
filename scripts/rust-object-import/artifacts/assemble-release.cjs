// Release jobs supply trusted artifacts explicitly; assembly never downloads or builds a helper.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { targets } = require('./contract.cjs');
const { assemble } = require('./install-helper.cjs');

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

if (require.main === module) {
  assert.equal(process.argv.length, 4, 'expected distribution and target');
  const destination = assembleRelease(process.argv[2], process.argv[3]);
  console.log(destination || 'No object-import artifact directory supplied; keeping Node-only distribution');
}
module.exports = { assembleRelease };
