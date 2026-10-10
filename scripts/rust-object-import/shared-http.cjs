// Functional production ObjectFetcher/Http/FetchRoute qualification, outside CLI timing.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const { createSharedFixture } = require('./shared-fixture.cjs');
const { destination, seedDestination, verify } = require('./scope-fixture.cjs');
const { benchmarkGlobals } = require('../rust-dependency-analysis/command-workspace.cjs');
const { createBenchmarkProcessControl } = require('../rust-dependency-analysis/process-tree-memory-control.cjs');
const [cli, helper, output] = process.argv.slice(2).map((value) => path.resolve(value));
assert.ok(cli && helper && output, 'usage: shared-http.cjs CLI HELPER REPORT');
const scratch = path.resolve(process.env.BIT_IMPORT_QUALIFICATION_TMPDIR || os.tmpdir());
const root = path.resolve(__dirname, '../..');
for (const value of [scratch, output])
  assert.ok(value !== root && !value.startsWith(root + path.sep), 'evidence must stay outside Git');
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');
(async () => {
  await fs.mkdir(scratch, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(scratch, 'bit-shared-http-'));
  process.env.BIT_GLOBALS_DIR = benchmarkGlobals(temporary);
  process.env.BIT_RUST_OBJECT_IMPORT = 'off';
  process.env.BIT_RUST_OBJECT_TAR = 'off';
  const helperHash = sha(await fs.readFile(helper));
  const cliProvenance = JSON.parse(await fs.readFile(path.join(cli, '.bit-object-import-build.json')));
  const guard = async () => {
    for (const file of cliProvenance.compiledModules)
      assert.equal(sha(await fs.readFile(path.join(cli, 'node_modules/@teambit', file.path))), file.sha256);
  };
  await guard();
  const runs = [];
  try {
    for (const scenario of ['success', 'interrupted'])
      for (const first of ['origin', 'cache'])
        for (const mode of ['legacy', 'tar', 'tar-operation']) {
          const directory = path.join(temporary, `${scenario}-${first}-${mode}`);
          await fs.mkdir(directory);
          const manifest = await createSharedFixture(cli, path.join(directory, 'remotes'), first);
          const target = path.join(directory, 'destination');
          const files = manifest.firstHashes.map((hash) => ({
            filename: path.join(target, 'objects', hash.slice(0, 2), hash.slice(2)),
          }));
          const gates = {
            [manifest.waitingRemote]: [
              ...files,
              ...manifest.markers.map(({ hash, marker }) => ({
                filename: path.join(target, 'objects', hash.slice(0, 2), hash.slice(2)),
                marker,
              })),
            ],
          };
          const server = cp.fork(
            path.join(__dirname, 'http-fixture.cjs'),
            [
              cli,
              JSON.stringify(manifest.remotes),
              JSON.stringify(gates),
              JSON.stringify(scenario === 'interrupted' ? [manifest.waitingRemote] : []),
            ],
            { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }
          );
          try {
            const [ready] = await once(server, 'message', { signal: AbortSignal.timeout(10000) });
            manifest.remotes = ready.remotes;
            const released = [],
              interrupted = [];
            server.on('message', (message) => {
              if (message.gateReleased) released.push(message.gateReleased);
              if (message.interruptedRemote) interrupted.push(message.interruptedRemote);
            });
            await destination(cli, target, manifest);
            await seedDestination(cli, target, manifest);
            if (scenario === 'interrupted') {
              const load = createRequire(path.join(cli, 'package.json'));
              const { Scope } = load('@teambit/legacy.scope');
              const { Ref } = load('@teambit/objects');
              const scope = await Scope.load(target, false);
              for (const expected of Object.values(manifest.components)) {
                const existing = await scope.objects.load(new Ref(expected.hash));
                expected.tags = Object.fromEntries(
                  Object.entries(existing.versions).map(([tag, ref]) => [tag, ref.toString()])
                );
                expected.remoteHead = undefined;
              }
              scope.objects.clearObjectsFromCache();
              delete Scope.scopeCache[target];
              manifest.hashes = Object.fromEntries(
                Object.entries(manifest.hashes).filter(
                  ([hash, value]) => value.type !== 'Version' || manifest.firstHashes.includes(hash)
                )
              );
              manifest.localHashes = Object.fromEntries(
                Object.entries(manifest.localHashes).filter(
                  ([hash]) => !manifest.cacheExtraRefs.includes(hash) || first === 'cache'
                )
              );
            }
            const manifestFile = path.join(directory, 'manifest.json');
            await fs.writeFile(manifestFile, JSON.stringify(manifest));
            const traceFile = path.join(directory, 'trace.json');
            const env = {
              ...process.env,
              CI: '1',
              BIT_RUST_OBJECT_IMPORT: mode !== 'legacy' ? helper : 'off',
              BIT_RUST_OBJECT_TAR: mode !== 'legacy' ? 'on' : 'off',
              BIT_RUST_OBJECT_TAR_PROGRESSIVE: 'on',
              BIT_RUST_OBJECT_IMPORT_METADATA: 'on',
              BIT_RUST_OBJECT_IMPORT_MUTABLE: 'on',
              BIT_RUST_OBJECT_IMPORT_OPERATION: mode === 'tar-operation' ? 'on' : 'off',
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
                path.join(__dirname, 'shared-http-worker.cjs'),
                cli,
                target,
                manifestFile,
              ],
              { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
            );
            const control = createBenchmarkProcessControl(child, { timeoutMs: 30000 });
            let stdout = '',
              stderr = '';
            child.stdout.on('data', (chunk) => (stdout += chunk));
            child.stderr.on('data', (chunk) => (stderr += chunk));
            const [code] = await once(child, 'close');
            if (control.failure) throw control.failure;
            let hashes;
            const trace = JSON.parse(await fs.readFile(traceFile));
            assert.deepEqual(released, [manifest.waitingRemote]);
            assert.equal(
              (trace.stages.versionHistoryMergePolicy?.calls || 0) +
                (trace.stages.versionHistoryNativeApply?.calls || 0),
              4
            );
            if (scenario === 'interrupted') {
              assert.notEqual(code, 0, 'partial second response must reject the fetch');
              assert.deepEqual(interrupted, [manifest.waitingRemote]);
              assert.match(stderr, /abort|premature|network|reset|closed|fetch|EOF|incomplete/i);
              assert.equal(trace.stages.modelComponentMergePolicy?.calls || 0, 0);
            } else {
              assert.equal(code, 0, stderr || stdout);
              hashes = JSON.parse(stdout).hashes;
              assert.equal(new Set(hashes).size, hashes.length, 'shared queue must reserve each hash once');
              assert.equal(trace.stages.modelComponentMergePolicy.calls, 4);
            }
            if (mode !== 'legacy') {
              assert.equal(trace.tar.nativeSources, 4);
              assert.equal(trace.native.mutableSubmitted, trace.native.mutablePersisted);
              assert.equal(trace.native.mutablePersisted, scenario === 'success' ? 40 : first === 'cache' ? 16 : 36);
              assert.equal(trace.native.mutableFallbacks, 0);
              assert.equal(trace.inflation.incoming, 0);
              if (scenario === 'success') {
                assert.equal(trace.tar.operations, 2);
                assert.equal(trace.tar.fallbacks, 0);
              }
            }
            const verification = await verify(cli, target, manifest);
            runs.push({ scenario, first, mode, code, released, interrupted, verification, trace, hashes });
          } finally {
            server.disconnect();
            server.kill();
          }
        }
    for (const scenario of ['success', 'interrupted'])
      for (const first of ['origin', 'cache']) {
        const pair = runs.filter((run) => run.first === first && run.scenario === scenario);
        for (const run of pair.slice(1)) assert.equal(pair[0].verification.modelsSha256, run.verification.modelsSha256);
      }
    assert.notEqual(
      runs.find((run) => run.scenario === 'success' && run.first === 'origin' && run.mode === 'legacy').verification
        .modelsSha256,
      runs.find((run) => run.scenario === 'success' && run.first === 'cache' && run.mode === 'legacy').verification
        .modelsSha256,
      'arrival-sensitive histories must actually differ'
    );
    await guard();
    assert.equal(sha(await fs.readFile(helper)), helperHash);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(
      output,
      JSON.stringify(
        {
          schemaVersion: 1,
          filesystemType: (await fs.statfs(temporary)).type,
          helperSha256: helperHash,
          cliProvenance,
          harnessSha256: Object.fromEntries(
            await Promise.all(
              [
                'shared-http.cjs',
                'shared-http-worker.cjs',
                'shared-fixture.cjs',
                'scope-fixture.cjs',
                'http-fixture.cjs',
                'import-trace.cjs',
              ].map(async (name) => [name, sha(await fs.readFile(path.join(__dirname, name)))])
            )
          ),
          runs,
        },
        null,
        2
      )
    );
    console.log('Shared origin/cache first-history persistence and authoritative model parity verified');
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
