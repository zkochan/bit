// Actual checkout/reset/revert against distinct production Source and Version objects.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { benchmarkGlobals } = require('../rust-dependency-analysis/command-workspace.cjs');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function createCheckoutFixture(cliRoot, directory) {
  const load = createRequire(path.join(cliRoot, 'package.json'));
  const { Scope } = load('@teambit/legacy.scope');
  const { Source, Version, ModelComponent, VersionHistory } = load('@teambit/objects');
  const scopeName = 'qualification.checkout';
  const scope = await Scope.ensure(directory, scopeName);
  await scope.ensureDir();
  const definitions = [
    {
      'index.js': Buffer.from('export default "one";\n'),
      'removed.js': Buffer.from('export const removed = 1;\n'),
      'Case.js': Buffer.from('export default "upper";\n'),
      'binary.bin': Buffer.from([0, 255, 13, 10, 128]),
    },
    {
      'index.js': Buffer.from('export default "two";\n'),
      'added.js': Buffer.from('export const added = 2;\n'),
      'case.js': Buffer.from('export default "lower";\n'),
      'binary.bin': Buffer.from([0, 254, 13, 10, 129]),
    },
  ];
  const objects = [];
  const versions = [];
  const sourceRefs = {};
  for (const [index, files] of definitions.entries()) {
    const models = Object.entries(files).map(([relativePath, contents]) => {
      const source = Source.from(contents);
      objects.push(source);
      sourceRefs[`${index}/${relativePath}`] = source.hash().toString();
      return { name: path.basename(relativePath), relativePath, test: false, file: source.hash() };
    });
    const version = new Version({
      schema: '1.0.0',
      mainFile: 'index.js',
      bindingPrefix: '@qualification',
      devPackageDependencies: { '@types/jest': '26.0.20', '@types/node': '22.10.5' },
      overrides: { devDependencies: { '@types/jest': '26.0.20', '@types/node': '22.10.5' } },
      files: models,
      log: {
        message: `checkout fixture ${index}`,
        date: String(1700000000000 + index),
        username: 'fixture',
        email: 'fixture@example.invalid',
      },
      parents: index ? [versions[index - 1].hash()] : [],
    });
    version._hash = version.calculateHash().toString();
    version.validate();
    versions.push(version);
  }
  const component = ModelComponent.from({
    name: 'component',
    scope: scopeName,
    versions: { '1.0.0': versions[0].hash(), '1.0.1': versions[1].hash() },
    head: versions[1].hash(),
  });
  const history = new VersionHistory({
    name: 'component',
    scope: scopeName,
    versions: versions.map((v) => ({ hash: v.hash(), parents: v.parents })),
    graphCompleteRefs: versions.map((v) => v.hash().toString()),
  });
  await scope.objects.writeObjectsToTheFS([...objects, ...versions, history, component]);
  Scope.scopeCache = {};
  return {
    id: `${scopeName}/component`,
    remotes: { [scopeName]: `file://${directory}` },
    definitions,
    sourceRefs,
    versionRefs: versions.map((v) => v.hash().toString()),
  };
}
async function runQualification(cliRoot, helper, options = {}) {
  cliRoot = path.resolve(cliRoot);
  helper = path.resolve(helper);
  const provenance = JSON.parse(await fs.readFile(path.join(cliRoot, '.bit-object-import-build.json'), 'utf8'));
  const repository = path.resolve(__dirname, '../..');
  for (const [filename, expected] of Object.entries(provenance.sourceSha256)) {
    assert.equal(digest(await fs.readFile(path.join(repository, filename))), expected, `source provenance ${filename}`);
  }
  for (const module of provenance.compiledModules)
    assert.equal(
      digest(await fs.readFile(path.join(cliRoot, 'node_modules/@teambit', module.path))),
      module.sha256,
      `compiled provenance ${module.path}`
    );
  const temporary = await fs.mkdtemp(path.join(options.scratch || os.tmpdir(), 'bit-real-checkout-'));
  const globals = benchmarkGlobals(temporary);
  const fixture = await createCheckoutFixture(cliRoot, path.join(temporary, 'remote'));
  const load = createRequire(path.join(cliRoot, 'package.json'));
  const eol = load('@teambit/toolbox.string.eol');
  const baseEnv = {
    ...process.env,
    BIT_GLOBALS_DIR: globals,
    CI: '1',
    BIT_RUST_OBJECT_IMPORT: helper,
    BIT_RUST_OBJECT_TAR: 'off',
    BIT_RUST_OBJECT_IMPORT_OPERATION: 'off',
    BIT_RUST_WORKSPACE_MATERIALIZATION: 'off',
    BIT_RUST_WORKSPACE_PERSISTENCE: 'off',
    BIT_RUST_CLIENT_VCS: 'off',
  };
  async function command(cwd, args, native, executable = helper, traceFile) {
    const started = performance.now();
    const result = await new Promise((resolve, reject) => {
      const commandArgs = [path.join(cliRoot, 'bin/bit.js'), ...args];
      if (traceFile) commandArgs.unshift('--require', path.join(__dirname, 'import-trace.cjs'));
      const env = { ...baseEnv, BIT_RUST_OBJECT_IMPORT: executable, BIT_RUST_CLIENT_VCS: native ? 'on' : 'off' };
      delete env.BIT_IMPORT_TRACE;
      delete env.BIT_IMPORT_TRACE_OWNER;
      if (traceFile) env.BIT_IMPORT_TRACE = traceFile;
      const child = cp.spawn(process.execPath, commandArgs, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
      child.once('error', reject);
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, wallMs: performance.now() - started });
      });
    });
    assert.equal(result.code, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  }
  async function bitmap(directory) {
    const map = load('comment-json').parse(await fs.readFile(path.join(directory, '.bitmap'), 'utf8'));
    const entry = Object.values(map).find((value) => value && `${value.scope}/${value.name}` === fixture.id);
    assert.ok(entry?.rootDir, 'fixture bitmap entry');
    return entry;
  }
  async function verify(directory, version, bitmapVersion) {
    const entry = await bitmap(directory);
    assert.equal(entry.version, bitmapVersion);
    const root = path.join(directory, entry.rootDir);
    const files = fixture.definitions[version];
    for (const [filename, bytes] of Object.entries(files))
      assert.deepEqual(await fs.readFile(path.join(root, filename)), eol.auto(bytes), filename);
    const actual = (await fs.readdir(root)).filter((name) => name !== 'package.json').sort();
    assert.deepEqual(actual, Object.keys(files).sort(), 'tracked files after checkout');
    return {
      bitmapVersion,
      files: Object.fromEntries(
        await Promise.all(
          Object.keys(files)
            .sort()
            .map(async (filename) => [filename, digest(await fs.readFile(path.join(root, filename)))])
        )
      ),
    };
  }
  const runs = [];
  for (const mode of ['node', 'native', 'missing-helper', 'crashed-helper']) {
    const directory = path.join(temporary, mode);
    await fs.mkdir(directory);
    await command(directory, ['init', '--skip-interactive', '--default-scope', 'qualification.destination'], false);
    const scopeFile = path.join(directory, '.bit/scope.json');
    const scopeJson = JSON.parse(await fs.readFile(scopeFile, 'utf8'));
    scopeJson.remotes = fixture.remotes;
    await fs.writeFile(scopeFile, JSON.stringify(scopeJson));
    await fs.writeFile(
      path.join(directory, 'package.json'),
      JSON.stringify({ name: 'checkout-qualification', private: true, type: 'module' })
    );
    await command(
      directory,
      ['import', `${fixture.id}@1.0.1`, '--all-history', '--skip-dependency-installation', '--override', '--safe-mode'],
      false
    );
    await verify(directory, 1, '1.0.1');
    const selectedHelper =
      mode === 'missing-helper'
        ? path.join(directory, 'missing-helper')
        : mode === 'crashed-helper'
          ? process.execPath
          : helper;
    const checkout = await command(
      directory,
      ['checkout', '1.0.0', fixture.id, '--skip-dependency-installation'],
      mode !== 'node',
      selectedHelper
    );
    const checkoutState = await verify(directory, 0, '1.0.0');
    const entry = await bitmap(directory);
    const root = path.join(directory, entry.rootDir);
    await fs.writeFile(path.join(root, 'index.js'), 'local edits\n');
    await fs.rm(path.join(root, 'removed.js'));
    const reset = await command(
      directory,
      ['checkout', 'reset', fixture.id, '--skip-dependency-installation'],
      mode !== 'node',
      selectedHelper
    );
    const resetState = await verify(directory, 0, '1.0.0');
    const revert = await command(
      directory,
      ['revert', fixture.id, '1.0.1', '--skip-dependency-installation'],
      mode !== 'node',
      selectedHelper
    );
    const revertState = await verify(directory, 1, '1.0.0');
    let diagnostic;
    if (mode === 'native') {
      // Diagnostic commands are excluded from the measured operations above.
      await command(directory, ['checkout', 'reset', fixture.id, '--skip-dependency-installation'], true);
      const traceFile = path.join(directory, 'checkout-trace.json');
      await command(
        directory,
        ['checkout', '1.0.1', fixture.id, '--skip-dependency-installation'],
        true,
        helper,
        traceFile
      );
      const trace = JSON.parse(await fs.readFile(traceFile, 'utf8'));
      const writes = trace.checkout.write;
      assert.ok(writes.files > 0, 'actual checkout must write preflighted sources through BWC1');
      assert.equal(writes.completed, writes.files);
      assert.equal(writes.failed, 0);
      assert.ok(trace.checkout.preflight.files > 0);
      diagnostic = { trace, state: await verify(directory, 1, '1.0.1') };
    }
    runs.push({ mode, checkout, reset, revert, checkoutState, resetState, revertState, diagnostic });
  }
  for (const operation of ['checkoutState', 'resetState', 'revertState'])
    for (const run of runs.slice(1))
      assert.deepEqual(run[operation], runs[0][operation], `${run.mode} ${operation} parity`);
  const report = {
    schemaVersion: 1,
    temporary,
    node: process.version,
    helperSha256: digest(await fs.readFile(helper)),
    cliProvenance: provenance,
    harnessSha256: digest(await fs.readFile(__filename)),
    runs,
  };
  if (options.report) await fs.writeFile(options.report, JSON.stringify(report, null, 2));
  return report;
}
module.exports = { createCheckoutFixture, runQualification };
if (require.main === module)
  runQualification(process.argv[2], process.argv[3], {
    scratch: process.env.BIT_CHECKOUT_QUALIFICATION_TMPDIR,
    report: process.env.BIT_CHECKOUT_QUALIFICATION_REPORT,
  })
    .then((report) => console.log(JSON.stringify({ temporary: report.temporary, runs: report.runs.length })))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
