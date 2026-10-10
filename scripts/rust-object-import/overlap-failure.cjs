// A genuine HTTP CLI conflict must retain acknowledged objects without committing conflicting models.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { createFixture, seedDestination, verify } = require('./scope-fixture.cjs');
const { benchmarkGlobals } = require('../rust-dependency-analysis/command-workspace.cjs');
const { createBenchmarkProcessControl } = require('../rust-dependency-analysis/process-tree-memory-control.cjs');
const [cli, helper, output] = process.argv.slice(2).map((value) => path.resolve(value));
assert.ok(cli && helper && output, 'usage: overlap-failure.cjs CLI HELPER REPORT');
const scratch = path.resolve(process.env.BIT_IMPORT_QUALIFICATION_TMPDIR || os.tmpdir());
const root = path.resolve(__dirname, '../..');
for (const file of [scratch, output])
  assert.ok(file !== root && !file.startsWith(root + path.sep), 'evidence must stay outside Git');
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');
(async () => {
  await fs.mkdir(scratch, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(scratch, 'bit-overlap-failure-'));
  process.env.BIT_GLOBALS_DIR = benchmarkGlobals(temporary);
  process.env.BIT_RUST_OBJECT_IMPORT = 'off';
  process.env.BIT_RUST_OBJECT_TAR = 'off';
  const cliProvenance = JSON.parse(await fs.readFile(path.join(cli, '.bit-object-import-build.json')));
  async function verifyCompiled() {
    for (const file of cliProvenance.compiledModules)
      assert.equal(
        sha(await fs.readFile(path.join(cli, 'node_modules/@teambit', file.path))),
        file.sha256,
        'compiled CLI changed during qualification'
      );
  }
  await verifyCompiled();
  const helperHash = sha(await fs.readFile(helper));
  const manifest = await createFixture(cli, path.join(temporary, 'remotes'), {
    components: 2,
    files: 1,
    bytes: 1024,
    versions: 4,
    overlap: 'conflict',
  });
  const server = cp.fork(path.join(__dirname, 'http-fixture.cjs'), [cli, JSON.stringify(manifest.remotes)], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  try {
    const ready = await Promise.race([
      once(server, 'message', { signal: AbortSignal.timeout(10000) }),
      once(server, 'exit').then(() => {
        throw new Error('HTTP server exited');
      }),
    ]);
    manifest.remotes = ready[0].remotes;
    const runs = [];
    for (const mode of ['legacy', 'tar']) {
      const directory = path.join(temporary, mode);
      await fs.mkdir(directory);
      cp.execFileSync(
        process.execPath,
        [
          path.join(cli, 'bin/bit.js'),
          'init',
          '--standalone',
          '--skip-interactive',
          '--default-scope',
          'qualification.destination',
        ],
        { cwd: directory, env: { ...process.env, CI: '1' }, stdio: 'ignore' }
      );
      const jsonFile = path.join(directory, '.bit/scope.json');
      const json = JSON.parse(await fs.readFile(jsonFile));
      json.remotes = manifest.remotes;
      await fs.writeFile(jsonFile, JSON.stringify(json));
      await seedDestination(cli, path.join(directory, '.bit'), manifest);
      const traceFile = path.join(directory, 'trace.json');
      const env = {
        ...process.env,
        CI: '1',
        BIT_RUST_OBJECT_IMPORT: mode === 'tar' ? helper : 'off',
        BIT_RUST_OBJECT_TAR: mode === 'tar' ? 'on' : 'off',
        BIT_RUST_OBJECT_TAR_PROGRESSIVE: 'on',
        BIT_RUST_OBJECT_IMPORT_METADATA: 'on',
        BIT_RUST_OBJECT_IMPORT_MUTABLE: 'on',
        BIT_IMPORT_TRACE: traceFile,
      };
      delete env.BIT_IMPORT_TRACE_OWNER;
      delete env.BIT_IMPORT_CPU_PROFILE;
      delete env.BIT_IMPORT_CPU_PROFILE_OWNER;
      const child = cp.spawn(
        process.execPath,
        [
          '--require',
          path.join(__dirname, 'import-trace.cjs'),
          path.join(cli, 'bin/bit.js'),
          'import',
          ...manifest.ids,
          '--objects',
          '--all-history',
          '--skip-dependency-installation',
          '--json',
          '--safe-mode',
        ],
        { cwd: directory, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      const control = createBenchmarkProcessControl(child, { timeoutMs: 120000 });
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      const [code] = await once(child, 'close');
      if (control.failure) throw control.failure;
      assert.notEqual(code, 0, 'local conflicting origin tag must reject import');
      assert.match(stdout + stderr, /conflict/i);
      assert.match(stdout + stderr, /1\.0\.0/);
      const trace = JSON.parse(await fs.readFile(traceFile));
      assert.equal(trace.stages.versionHistoryMergePolicy.calls, 2);
      assert.ok(trace.stages.modelComponentMergePolicy.calls > 0);
      if (mode === 'tar') {
        assert.equal(trace.native.mutableSubmitted, trace.native.mutablePersisted);
        assert.ok(trace.native.mutablePersisted > 0, 'acknowledged native prefix must be real');
        assert.equal(trace.native.mutableFallbacks, 0);
        assert.equal(trace.tar.fallbacks, 0);
        assert.equal(trace.tar.nativeSources, 2);
        assert.equal(trace.inflation.incoming, 0);
        assert.equal(trace.objectTypes.Source || 0, 0);
      }
      const verification = await verify(cli, path.join(directory, '.bit'), manifest);
      runs.push({ mode, code, verification, trace, stdout, stderr });
    }
    assert.equal(
      runs[0].verification.modelsSha256,
      runs[1].verification.modelsSha256,
      'failure state must match canonical import'
    );
    await verifyCompiled();
    assert.equal(sha(await fs.readFile(helper)), helperHash);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(
      output,
      JSON.stringify(
        {
          schemaVersion: 1,
          cliProvenance,
          temporary,
          filesystemType: (await fs.statfs(temporary)).type,
          helperSha256: helperHash,
          harnessSha256: Object.fromEntries(
            await Promise.all(
              ['overlap-failure.cjs', 'scope-fixture.cjs', 'http-fixture.cjs', 'import-trace.cjs'].map(async (name) => [
                name,
                sha(await fs.readFile(path.join(__dirname, name))),
              ])
            )
          ),
          runs,
        },
        null,
        2
      )
    );
    console.log('Canonical/native conflict prefix and retained local model state verified');
  } finally {
    server.disconnect();
    server.kill();
    await fs.rm(temporary, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
