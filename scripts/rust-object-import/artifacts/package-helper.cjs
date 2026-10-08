// Release build and packaging only; no downloading, installation or publishing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  ROOT,
  targets,
  command,
  sha256,
  sourceIdentity,
  binaryName,
  buildCommand,
  verifyBinary,
  verifyMembers,
  minimumGlibc,
} = require('./contract.cjs');
const { encode, decode } = require('./archive.cjs');
const { notices } = require('./notices.cjs');

function packageHelper(directory, target) {
  assert.ok(path.isAbsolute(directory), 'artifact output must be absolute');
  let ancestor = directory;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const physical = path.join(fs.realpathSync(ancestor), path.relative(ancestor, directory));
  const relative = path.relative(fs.realpathSync(ROOT), physical);
  assert.ok(
    relative.startsWith('..' + path.sep) || path.isAbsolute(relative),
    'generated artifacts must stay outside the source repository'
  );
  const compiler = command(['rustc', '-vV']);
  target ||= compiler.match(/^host: (.+)$/m)?.[1];
  assert.ok(targets[target], 'unsupported artifact target');
  const identity = sourceIdentity();
  const build = buildCommand(target);
  const cargoTarget = path.join(ROOT, 'native/target');
  execFileSync(build[0], build.slice(1), {
    cwd: path.join(ROOT, 'native'),
    env: { ...process.env, CARGO_TARGET_DIR: cargoTarget },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  assert.equal(sourceIdentity(), identity, 'native sources changed during release build');
  const binaryPath = path.join(cargoTarget, target, 'release', binaryName(target));
  const stat = fs.lstatSync(binaryPath);
  assert.ok(stat.isFile() && stat.size <= 64 * 1024 * 1024, 'invalid release binary');
  const binary = fs.readFileSync(binaryPath);
  verifyBinary(binary, target);
  const license = fs.readFileSync(path.join(ROOT, 'LICENSE'));
  const inventory = notices(target, compiler);
  const manifest = {
    name: 'bit-object-import',
    version: '0.1.0',
    artifactFormat: 2,
    protocolVersion: 1,
    gitRevision: command(['git', 'rev-parse', 'HEAD']),
    // Pull-request CI builds GitHub's transient merge commit; its parents name the base and PR head.
    // Read the raw commit object: a shallow checkout's history reports no parents.
    gitParents: command(['git', 'cat-file', 'commit', 'HEAD'])
      .split('\n\n', 1)[0]
      .split('\n')
      .filter((line) => line.startsWith('parent '))
      .map((line) => line.slice('parent '.length)),
    objectImportSourceSha256: identity,
    cargoLockSha256: sha256(fs.readFileSync(path.join(ROOT, 'native/Cargo.lock'))),
    target,
    platform: targets[target],
    rustc: compiler,
    provenance: {
      revisionScope: 'source checkout HEAD; source digest identifies build inputs',
      binaryInput: 'checkout release output',
      buildCommand: build,
    },
    dependencies: inventory.dependencies,
    binary: { name: binaryName(target), bytes: binary.length, sha256: sha256(binary) },
    license: { name: 'LICENSE', sha256: sha256(license) },
    notices: { name: 'THIRD-PARTY-NOTICES.txt', sha256: sha256(inventory.data) },
  };
  if (target.endsWith('-gnu')) manifest.minimumGlibc = minimumGlibc(binary);
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  const members = {
    LICENSE: license,
    'THIRD-PARTY-NOTICES.txt': inventory.data,
    [binaryName(target)]: binary,
    'manifest.json': manifestBytes,
  };
  verifyMembers(members);
  const archive = encode(members);
  verifyMembers(decode(archive));
  fs.mkdirSync(directory, { recursive: true });
  const filename = `bit-object-import-${manifest.version}-${target}-${manifest.gitRevision.slice(0, 12)}.tar.gz`;
  const output = path.join(directory, filename);
  fs.writeFileSync(output, archive);
  fs.writeFileSync(output + '.sha256', `${sha256(archive)}  ${filename}\n`);
  fs.writeFileSync(output + '.manifest.json', manifestBytes);
  return output;
}
if (require.main === module) {
  const args = process.argv.slice(2);
  assert.ok(
    args.length === 2 || args.length === 4,
    'usage: package-helper.cjs --directory ABSOLUTE_PATH [--target TARGET]'
  );
  assert.equal(args[0], '--directory');
  if (args.length === 4) assert.equal(args[2], '--target');
  console.log(packageHelper(args[1], args[3]));
}
module.exports = { packageHelper };
