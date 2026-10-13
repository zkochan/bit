const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { source, installed } = require('./load-source.cjs');
const { writeComponents, mutate } = require('./workspace-inspection-fixture.cjs');
const { benchmarkGlobals } = require('../rust-dependency-analysis/command-workspace.cjs');

const readRustStatus =
  process.env.BIT_TEST_STATUS_COMPILED === '1'
    ? installed('@teambit/bit/dist/rust-status.js').readRustStatus
    : source('scopes/harmony/bit/rust-status.ts').readRustStatus;

test('cold full status owns real default-Node workspaces and preserves canonical JSON', async (t) => {
  assert.ok(process.env.BIT_LEGACY_ROOT, 'canonical CLI is required');
  assert.ok(process.env.BIT_TEST_OBJECT_IMPORT, 'native helper is required');
  assert.ok(process.env.BIT_TEST_WORKSPACE_ADDON, 'native addon is required');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-full-status-runtime-'));
  const directory = path.join(temporary, 'workspace');
  await fs.mkdir(directory);
  const globals = benchmarkGlobals(temporary);
  const previous = { flag: process.env.BIT_RUST_CLIENT_VCS, helper: process.env.BIT_RUST_OBJECT_IMPORT };
  process.env.BIT_RUST_CLIENT_VCS = 'on';
  process.env.BIT_RUST_OBJECT_IMPORT = process.env.BIT_TEST_OBJECT_IMPORT;
  t.after(async () => {
    await fs.rm(temporary, { recursive: true, force: true });
    for (const [key, value] of [
      ['BIT_RUST_CLIENT_VCS', previous.flag],
      ['BIT_RUST_OBJECT_IMPORT', previous.helper],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  function command(args) {
    return execFileSync(process.execPath, [path.join(process.env.BIT_LEGACY_ROOT, 'bin/bit.js'), ...args], {
      cwd: directory,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, CI: '1', BIT_GLOBALS_DIR: globals, BIT_RUST_CLIENT_VCS: 'off' },
    });
  }
  command(['init', '--skip-interactive', '--default-scope', 'qualification.inspection']);
  const scopeFile = path.join(directory, '.bit/scope.json');
  const scope = JSON.parse(await fs.readFile(scopeFile, 'utf8'));
  scope.name = 'qualification.inspection';
  await fs.writeFile(scopeFile, JSON.stringify(scope));
  await fs.writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify({ name: 'full-status-runtime', private: true })
  );
  await writeComponents(directory);
  for (const name of ['alpha', 'beta']) command(['add', name, '--id', name, '--main', 'index.js']);
  command(['link']);
  command([
    'tag',
    '--ver',
    '1.0.0',
    '--message',
    'full status baseline',
    '--soft',
    '--disable-tag-pipeline',
    '--ignore-issues',
    '*',
  ]);
  command(['tag', '--persist=skip-build', '--disable-tag-pipeline', '--ignore-issues', '*']);
  const compare = async (label) => {
    // The canonical read refreshes the dependency cache; the production route must then own the next read.
    const expected = JSON.parse(command(['status', '--json']));
    const actual = await readRustStatus(directory, temporary);
    assert.ok(actual, `${label}: native command must complete, not silently fall back`);
    assert.deepEqual(actual, expected, label);
    assert.equal(JSON.stringify(actual), JSON.stringify(expected), `${label}: JSON property order`);
    return actual;
  };
  const clean = await compare('clean');
  assert.deepEqual(clean.modifiedComponents, []);
  for (const phase of ['eol', 'config', 'content', 'inventory']) {
    await mutate(directory, phase);
    await compare(phase);
  }
  await fs.mkdir(path.join(directory, 'alpha/dist'), { recursive: true });
  await fs.mkdir(path.join(directory, 'beta/dist'), { recursive: true });
  await compare('dist existence');
  await fs.rm(path.join(directory, 'beta/dist'), { recursive: true });
  await fs.writeFile(
    path.join(directory, 'beta/index.js'),
    "module.exports = require('@qualification/inspection.alpha');\n"
  );
  await fs.writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify({
      name: 'full-status-runtime',
      private: true,
      dependencies: { '@qualification/inspection.beta': '1.0.0' },
    })
  );
  const cycle = await compare('circular and duplicate issue ordering');
  const betaIssues = cycle.componentsWithIssues
    .find((row) => row.id.endsWith('/beta'))
    .issues.map((issue) => issue.type);
  for (const issue of ['CircularDependencies', 'DuplicateComponentAndPackage', 'MissingDists'])
    assert.ok(betaIssues.includes(issue), issue);
  await fs.mkdir(path.join(directory, 'gamma'));
  await fs.writeFile(path.join(directory, 'gamma/index.js'), 'module.exports = 3;\n');
  command(['add', 'gamma', '--id', 'gamma', '--main', 'index.js']);
  command(['link']);
  const added = await compare('new component');
  assert.deepEqual(added.newComponents, ['qualification.inspection/gamma']);
  await fs.rm(path.join(directory, '.bit/cache/components/deps'), { recursive: true, force: true });
  assert.equal(await readRustStatus(directory, temporary), undefined, 'absent dependency cache falls back');
  await compare('cache refresh');
  await fs.utimes(path.join(directory, 'gamma/index.js'), 2000000000, 2000000000);
  assert.equal(await readRustStatus(directory, temporary), undefined, 'stale dependency cache falls back');
  await fs.utimes(path.join(directory, 'gamma/index.js'), 1700000000, 1700000000);
  const workspaceFile = path.join(directory, 'workspace.jsonc');
  const original = await fs.readFile(workspaceFile);
  const workspace = installed('comment-json').parse(original.toString());
  workspace['qualification.custom/runtime'] = {};
  await fs.writeFile(workspaceFile, JSON.stringify(workspace));
  assert.equal(await readRustStatus(directory, temporary), undefined, 'configured runtime retains canonical callbacks');
  await fs.writeFile(workspaceFile, original);
  await fs.writeFile(path.join(temporary, '.bitrc.jsonc'), '{}');
  assert.equal(await readRustStatus(directory, temporary), undefined, 'global runtime configuration falls back');
});
