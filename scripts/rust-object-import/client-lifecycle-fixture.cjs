const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const checkout = require('./checkout-transition-fixture.cjs');

// These routes fork a genuinely imported, disposable workspace. The lifecycle
// driver must reset both workspace and remote before each route and mode.
const scenarios = [
  { name: 'remove-clean', operation: 'remove' },
  { name: 'remove-modified', operation: 'remove', modified: true },
  { name: 'remove-modified-force', operation: 'remove', modified: true, force: true },
  { name: 'remove-keep-files', operation: 'remove', keepFiles: true },
  { name: 'remove-track', operation: 'remove', track: true },
  { name: 'remove-track-keep-files', operation: 'remove', track: true, keepFiles: true },
  { name: 'remove-missing-main', operation: 'remove', missingMain: true },
  { name: 'remove-missing-root', operation: 'remove', missingRoot: true },
  { name: 'remove-new', operation: 'remove', newlyCreated: true },
  { name: 'remove-dependency', operation: 'remove', dependency: true },
  { name: 'lane-create-main', operation: 'laneCreate' },
  { name: 'lane-create-fork', operation: 'laneCreate', lane: true },
  { name: 'lane-create-duplicate', operation: 'laneCreate', duplicate: true, error: true },
  { name: 'lane-create-invalid', operation: 'laneCreate', invalid: true, error: true },
  { name: 'lane-remove-default', operation: 'laneRemove', defaultLane: true, error: true },
  { name: 'lane-remove-current', operation: 'laneRemove', lane: true, error: true },
];

async function prepareScenario(directory, scenario, roots, fixture, command) {
  const run = async (args) => {
    const result = await command(directory, args, 'node');
    assert.equal(result.code, 0, result.stderr || result.stdout);
  };
  if (scenario.modified)
    await fs.writeFile(path.join(roots.root, 'index.js'), 'export default "local lifecycle edit";\n');
  if (scenario.missingMain) await fs.rm(path.join(roots.root, 'index.js'));
  if (scenario.missingRoot) await fs.rm(roots.root, { recursive: true });
  if (scenario.newlyCreated) {
    const component = path.join(directory, 'new-component');
    await fs.mkdir(component);
    await fs.writeFile(path.join(component, 'index.js'), 'export default "new lifecycle component";\n');
    await run(['add', 'new-component', '--id', 'new-component', '--main', 'index.js']);
  }
  if (scenario.lane || scenario.duplicate)
    await run(['lane', 'create', scenario.duplicate ? 'created' : 'origin', '--scope', 'qualification.destination']);
}

function commandFor(scenario, fixture) {
  if (scenario.operation === 'remove') {
    const id = scenario.newlyCreated
      ? 'qualification.destination/new-component'
      : scenario.dependency
        ? fixture.dependencyId
        : fixture.id;
    return [
      'remove',
      id,
      '--silent',
      ...(scenario.force ? ['--force'] : []),
      ...(scenario.keepFiles ? ['--keep-files'] : []),
      ...(scenario.track ? ['--track'] : []),
    ];
  }
  if (scenario.operation === 'laneCreate')
    return ['lane', 'create', scenario.invalid ? 'INVALID' : 'created', '--scope', 'qualification.destination'];
  assert.equal(scenario.operation, 'laneRemove');
  return ['lane', 'remove', scenario.defaultLane ? 'main' : 'origin', '--force', '--silent'];
}

async function capture(directory, roots, packagePaths) {
  assert.ok(Array.isArray(packagePaths) && packagePaths.length, 'capture actual linked component package paths');
  const read = async (relative) => {
    try {
      return (await fs.readFile(path.join(directory, relative))).toString('hex');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  };
  const packages = {};
  for (const relative of packagePaths) {
    assert.ok(relative.startsWith('node_modules/') && !relative.split('/').includes('..'));
    const filename = path.join(directory, relative);
    try {
      const stat = await fs.lstat(filename);
      packages[relative] = stat.isSymbolicLink()
        ? { link: await fs.readlink(filename) }
        : { files: await checkout.readTree(filename) };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      packages[relative] = null;
    }
  }
  return {
    ...(await checkout.capture(directory, roots)),
    scopeConfig: await read('.bit/scope.json'),
    packageJson: await read('package.json'),
    packages,
    trash: await checkout.readTree(path.join(directory, '.bit/trash')),
    workspace: await checkout.readTree(directory),
  };
}

module.exports = {
  scenarios,
  prepareScenario,
  commandFor,
  createFixture: checkout.createFixture,
  capture,
};
