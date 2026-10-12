// Establish the canonical command/effect contract before enabling native lifecycle work.
// This runner deliberately cannot produce a native qualification report.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const fixtureModule = require('./client-lifecycle-fixture.cjs');
const { benchmarkGlobals } = require('../rust-dependency-analysis/command-workspace.cjs');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function runBaseline(cli, report) {
  cli = await fs.realpath(cli);
  assert.ok(cli.startsWith(os.tmpdir() + path.sep), 'use an isolated private CLI');
  report = path.resolve(report);
  const repository = path.resolve(__dirname, '../..');
  assert.ok(!report.startsWith(repository + path.sep), 'keep raw evidence outside the checkout');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-client-lifecycle-'));
  const load = createRequire(path.join(cli, 'package.json'));
  const env = { ...process.env, CI: '', BIT_GLOBALS_DIR: benchmarkGlobals(temporary) };
  for (const name of Object.keys(env))
    if (name.startsWith('BIT_RUST_') || name.startsWith('BIT_IMPORT_TRACE')) delete env[name];
  env.BIT_RUST_CLIENT_VCS = 'off';
  const command = (directory, args) =>
    new Promise((resolve, reject) => {
      const child = cp.spawn(
        process.execPath,
        ['--require', path.join(__dirname, 'history-query-determinism.cjs'), path.join(cli, 'bin/bit.js'), ...args],
        {
          cwd: directory,
          env: {
            ...env,
            BIT_CHECKOUT_TRANSITION_QUALIFICATION_SEED: hash(args.join('\0')),
            BIT_CHECKOUT_TRANSITION_QUALIFICATION_CLOCK: '1700000060000',
            BIT_CHECKOUT_TRANSITION_DISPLAY_DURATION: 'deterministic',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (data) => {
        stdout += data;
      });
      child.stderr.on('data', (data) => {
        stderr += data;
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, stdout, stderr });
      });
    });
  const successful = async (directory, args) => {
    const result = await command(directory, args);
    assert.equal(result.code, 0, result.stderr || result.stdout);
  };
  const fixture = await fixtureModule.createFixture(cli, path.join(temporary, 'remote'));
  await fs.cp(path.join(temporary, 'remote'), path.join(temporary, 'remote-pristine'), { recursive: true });
  const baseline = path.join(temporary, 'baseline');
  await fs.mkdir(baseline);
  await successful(baseline, ['init', '--skip-interactive', '--default-scope', 'qualification.destination']);
  const scopePath = path.join(baseline, '.bit/scope.json');
  const scope = JSON.parse(await fs.readFile(scopePath));
  scope.name = 'qualification.destination';
  scope.remotes = fixture.remotes;
  await fs.writeFile(scopePath, JSON.stringify(scope));
  await fs.writeFile(
    path.join(baseline, 'package.json'),
    JSON.stringify({ name: 'lifecycle-fixture', private: true, type: 'module' })
  );
  await successful(baseline, [
    'import',
    `${fixture.dependencyId}@1.0.0`,
    `${fixture.id}@1.0.1`,
    '--all-history',
    '--skip-dependency-installation',
    '--override',
    '--safe-mode',
  ]);
  await successful(baseline, ['link']);
  const bitmap = load('comment-json').parse(await fs.readFile(path.join(baseline, '.bitmap'), 'utf8'));
  const roots = ['component', 'dependency'].map(
    (name) => Object.values(bitmap).find((row) => row?.name === name)?.rootDir
  );
  assert.ok(roots.every(Boolean));
  const { ComponentID } = load('@teambit/component-id');
  const { getNodeModulesPathOfComponent } = load('@teambit/pkg.modules.component-package-name');
  const packagePaths = [fixture.id, fixture.dependencyId, 'qualification.destination/new-component'].map((id) =>
    getNodeModulesPathOfComponent({ id: ComponentID.fromString(id), bindingPrefix: '@qualification' })
      .split(path.sep)
      .join('/')
  );
  const seed = await fixtureModule.capture(baseline, roots, packagePaths);
  assert.ok(
    packagePaths.slice(0, 2).every((relative) => seed.packages[relative]),
    'capture real imported package links'
  );
  const states = report + '.states';
  await fs.mkdir(states, { recursive: true });
  const result = { qualified: false, baselineOnly: true, temporary, cli, stages: [] };
  for (const scenario of fixtureModule.scenarios) {
    const directory = path.join(temporary, 'routes', scenario.name);
    await fs.mkdir(path.dirname(directory), { recursive: true });
    await fs.cp(baseline, directory, { recursive: true, verbatimSymlinks: true });
    await fs.rm(path.join(temporary, 'remote'), { recursive: true, force: true });
    await fs.cp(path.join(temporary, 'remote-pristine'), path.join(temporary, 'remote'), { recursive: true });
    await fixtureModule.prepareScenario(
      directory,
      scenario,
      { root: path.join(directory, roots[0]) },
      fixture,
      command
    );
    const before = await fixtureModule.capture(directory, roots, packagePaths);
    const args = fixtureModule.commandFor(scenario, fixture);
    const output = await command(directory, args);
    const after = await fixtureModule.capture(directory, roots, packagePaths);
    const bytes = JSON.stringify({ scenario: scenario.name, args, before, output, after });
    const artifact = path.join(states, scenario.name + '.json');
    await fs.writeFile(artifact, bytes);
    result.stages.push({ scenario: scenario.name, artifact, sha256: hash(bytes), code: output.code });
    await fs.writeFile(report + '.partial', JSON.stringify(result, null, 2));
    assert.equal(output.signal, null);
    assert.equal(output.code, scenario.error ? 1 : 0, output.stderr || output.stdout);
    if (scenario.operation === 'remove') {
      const name = scenario.newlyCreated ? 'new-component' : scenario.dependency ? 'dependency' : 'component';
      const blocked = scenario.modified && !scenario.force;
      const afterBitmap = load('comment-json').parse(Buffer.from(after.bitmap, 'hex').toString());
      assert.equal(
        Object.values(afterBitmap).some((row) => row?.name === name),
        Boolean(blocked || scenario.track)
      );
      if (scenario.newlyCreated) {
        assert.equal(after.workspace['new-component/index.js'], undefined);
      } else {
        const root = roots[scenario.dependency ? 1 : 0];
        assert.deepEqual(after.roots[root], blocked || scenario.keepFiles ? before.roots[root] : {});
      }
      for (const [ref, value] of Object.entries(before.objects)) {
        const bytes = Buffer.from(value, 'hex');
        if (bytes.subarray(0, 7).toString() === 'Source ')
          assert.equal(after.objects[ref], value, 'do not garbage-collect Sources');
        if (!bytes.subarray(0, 10).equals(Buffer.from('Component '))) continue;
        const model = JSON.parse(bytes.subarray(bytes.indexOf(0) + 1));
        if (model.name !== name) continue;
        assert.equal(Object.hasOwn(after.objects, ref), Boolean(blocked));
        if (!blocked)
          for (const version of Object.values(model.versions)) assert.equal(after.objects[version], undefined);
      }
    }
  }
  await fs.writeFile(report, JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module)
  runBaseline(...process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
module.exports = { runBaseline };
