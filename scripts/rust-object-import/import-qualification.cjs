// Actual compiled `bit import --objects`; all destinations, globals and evidence are disposable.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const { createFixture, verify } = require('./scope-fixture.cjs');
const { createProcessTreeMemorySampler } = require('../rust-dependency-analysis/process-tree-memory.cjs');
const { createBenchmarkProcessControl } = require('../rust-dependency-analysis/process-tree-memory-control.cjs');
const { benchmarkGlobals } = require('../rust-dependency-analysis/command-workspace.cjs');
const cliRoot = path.resolve(process.argv[2] || '');
const helper = path.resolve(process.argv[3] || '');
const rounds = Number(process.env.BIT_IMPORT_QUALIFICATION_ROUNDS || 9);
const smoke = process.env.BIT_IMPORT_QUALIFICATION_SMOKE === '1';
const transport = process.env.BIT_IMPORT_QUALIFICATION_TRANSPORT || 'file';
assert.ok(['file', 'http'].includes(transport));
const selectedCases = process.env.BIT_IMPORT_QUALIFICATION_CASES?.split(',');
async function command(directory, ids, mode, allHistory, traceFile) {
  const cpuFile = path.join(directory, 'cpu.txt');
  const args = [
    path.join(cliRoot, 'bin/bit.js'),
    'import',
    ...ids,
    '--objects',
    '--skip-dependency-installation',
    '--json',
    '--safe-mode',
  ];
  if (allHistory) args.push('--all-history');
  if (traceFile) args.unshift('--require', path.join(__dirname, 'import-trace.cjs'));
  const env = {
    ...process.env,
    BIT_RUST_OBJECT_IMPORT:
      mode === 'native' || mode === 'validate'
        ? helper
        : mode === 'control'
          ? 'control'
          : mode === 'missing'
            ? path.join(directory, 'nonexistent-helper')
            : mode === 'crash'
              ? path.join(directory, 'crashing-helper')
              : 'off',
    BIT_RUST_OBJECT_IMPORT_MODE: mode === 'validate' ? 'validate' : 'store',
    CI: '1',
  };
  delete env.BIT_IMPORT_TRACE;
  delete env.BIT_IMPORT_TRACE_OWNER;
  if (traceFile) env.BIT_IMPORT_TRACE = traceFile;
  if (mode === 'crash')
    await fs.writeFile(
      path.join(directory, 'crashing-helper'),
      '#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.once("data",()=>process.exit(7));\n',
      { mode: 0o755 }
    );
  const started = performance.now();
  const child = cp.spawn('/usr/bin/time', ['-f', '%U %S', '-o', cpuFile, process.execPath, ...args], {
    cwd: directory,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const control = createBenchmarkProcessControl(child, { timeoutMs: 120000 });
  const sampler = createProcessTreeMemorySampler(child.pid, { intervalMs: 10 });
  sampler.start();
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  const elapsedMs = performance.now() - started;
  const memory = sampler.stop();
  if (control.failure) throw control.failure;
  assert.equal(code, 0, stderr || stdout);
  const result = JSON.parse(stdout);
  assert.equal(result.missingIds?.length || 0, 0);
  assert.equal(result.importDetails.length, ids.length);
  const [user, system] = (await fs.readFile(cpuFile, 'utf8')).trim().split(/\s+/).map(Number);
  return {
    mode,
    elapsedMs,
    cpuSeconds: user + system,
    memory,
    result,
    trace: traceFile ? JSON.parse(await fs.readFile(traceFile, 'utf8')) : undefined,
  };
}
async function workspace(directory, manifest) {
  await fs.mkdir(directory);
  cp.execFileSync(
    process.execPath,
    [
      path.join(cliRoot, 'bin/bit.js'),
      'init',
      '--standalone',
      '--skip-interactive',
      '--default-scope',
      'qualification.destination',
    ],
    { cwd: directory, env: { ...process.env, CI: '1' }, stdio: 'ignore' }
  );
  const file = path.join(directory, '.bit/scope.json');
  const json = JSON.parse(await fs.readFile(file, 'utf8'));
  json.remotes = manifest.remotes;
  await fs.writeFile(file, JSON.stringify(json, null, 2));
}
(async () => {
  assert.equal(process.platform, 'linux', 'GNU time and process-tree measurements require Linux');
  assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 100);
  const provenance = JSON.parse(await fs.readFile(path.join(cliRoot, '.bit-object-import-build.json'), 'utf8'));
  for (const file of provenance.compiledModules)
    assert.equal(
      createHash('sha256')
        .update(await fs.readFile(path.join(cliRoot, 'node_modules/@teambit', file.path)))
        .digest('hex'),
      file.sha256
    );
  const scratch = path.resolve(process.env.BIT_IMPORT_QUALIFICATION_TMPDIR || os.tmpdir());
  const repository = path.resolve(__dirname, '../..');
  assert.ok(
    scratch !== repository && !scratch.startsWith(repository + path.sep),
    'fixtures must stay outside the repository'
  );
  await fs.mkdir(scratch, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(scratch, 'bit-real-import-'));
  process.env.BIT_GLOBALS_DIR = benchmarkGlobals(temporary);
  const report = {
    schemaVersion: 1,
    temporary,
    filesystemType: (await fs.statfs(temporary)).type,
    node: process.version,
    cliProvenance: provenance,
    helperSha256: createHash('sha256')
      .update(await fs.readFile(helper))
      .digest('hex'),
    rounds,
    smoke,
    transport,
    serverCpuAndMemoryIncluded: false,
    command: 'bit import <ids> --objects --skip-dependency-installation --json --safe-mode [--all-history for cold]',
    cases: {},
  };
  const cases = smoke
    ? [['smoke', { components: 2, files: 2, bytes: 1024, versions: 3, remotes: 2 }]]
    : [
        ['many-small', { components: 100, files: 25, bytes: 1024, versions: 2 }],
        ['large-compressible', { components: 16, files: 2, bytes: 8 * 1024 * 1024, versions: 2 }],
        ['large-binary', { components: 16, files: 2, bytes: 4 * 1024 * 1024, versions: 2, binary: true }],
        ['mutable-heavy', { components: 400, files: 1, bytes: 1024, versions: 8 }],
        ['multi-remote', { components: 8, files: 2, bytes: 8 * 1024 * 1024, versions: 2, remotes: 2 }],
      ];
  for (const [name, options] of cases) {
    if (selectedCases && !selectedCases.includes(name)) continue;
    const directory = path.join(temporary, name);
    await fs.mkdir(directory);
    const manifest = await createFixture(cliRoot, path.join(directory, 'remotes'), options);
    let server;
    if (transport === 'http') {
      server = cp.fork(path.join(__dirname, 'http-fixture.cjs'), [cliRoot, JSON.stringify(manifest.remotes)], {
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
      const ready = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          server.kill();
          reject(new Error('HTTP fixture startup timed out'));
        }, 10000);
        server.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        server.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`HTTP fixture exited ${code}`));
        });
        server.once('message', (message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
      manifest.remotes = ready.remotes;
    }
    try {
      const data = (report.cases[name] = {
        options,
        sourceBytes: manifest.sourceBytes,
        expectedObjects: Object.keys(manifest.hashes).length,
        runs: [],
        diagnostics: [],
      });
      let expectedModels;
      function checkModels(verification) {
        expectedModels ||= verification.modelsSha256;
        assert.equal(
          verification.modelsSha256,
          expectedModels,
          'model data must match across modes and repeated commands'
        );
      }
      for (let round = -1; round < rounds; round++) {
        const modes = ['legacy', 'control', 'validate', 'native'];
        for (let offset = 0; offset < modes.length; offset++) {
          const mode = modes[(offset + Math.max(round, 0)) % modes.length];
          const destination = path.join(directory, `${round}-${mode}`);
          await workspace(destination, manifest);
          const cold = await command(destination, manifest.ids, mode, true);
          cold.verification = await verify(cliRoot, path.join(destination, '.bit'), manifest);
          checkModels(cold.verification);
          const warm = await command(destination, manifest.ids, mode, false);
          warm.verification = await verify(cliRoot, path.join(destination, '.bit'), manifest);
          checkModels(warm.verification);
          await new Promise((resolve) => setImmediate(resolve));
          global.gc?.();
          if (round >= 0) data.runs.push({ round, cold, warm });
          await fs.rm(destination, { recursive: true, force: true });
        }
      }
      for (const mode of ['legacy', 'control', 'validate', 'native', ...(smoke ? ['missing', 'crash'] : [])]) {
        const destination = path.join(directory, `diagnostic-${mode}`);
        await workspace(destination, manifest);
        const cold = await command(destination, manifest.ids, mode, true, path.join(destination, 'cold-trace.json'));
        cold.verification = await verify(cliRoot, path.join(destination, '.bit'), manifest);
        checkModels(cold.verification);
        const warm = await command(destination, manifest.ids, mode, false, path.join(destination, 'warm-trace.json'));
        warm.verification = await verify(cliRoot, path.join(destination, '.bit'), manifest);
        checkModels(warm.verification);
        await new Promise((resolve) => setImmediate(resolve));
        global.gc?.();
        if (mode === 'native' || mode === 'validate') {
          const expectedSources = Object.values(manifest.hashes).filter((obj) => obj.type === 'Source').length;
          assert.equal(cold.trace.native.sources, expectedSources, 'native cold Source coverage must be real');
          if (mode === 'native') {
            assert.equal(cold.trace.native.persisted, expectedSources, 'Sources must be committed by Rust');
            assert.equal(cold.trace.stages.nativeAtomicPersistence?.calls || 0, 0, 'no per-Source Node atomic writes');
            assert.equal(cold.trace.native.writeFallbacks, 0);
          }
          assert.equal(warm.trace.native.sources, 0, 'ordinary repeated import should not reprocess Sources');
          assert.ok(cold.trace.stages.componentMergeAndIndex?.calls, 'actual mutable component merge required');
        }
        if (mode === 'missing' || mode === 'crash') assert.equal(cold.trace.native.sources, 0);
        data.diagnostics.push({ mode, cold, warm });
        await fs.rm(destination, { recursive: true, force: true });
      }
      await fs.writeFile(path.join(temporary, 'results.json'), JSON.stringify(report, null, 2));
      if (process.env.BIT_IMPORT_QUALIFICATION_REPORT) {
        const saved = path.resolve(process.env.BIT_IMPORT_QUALIFICATION_REPORT);
        const repository = path.resolve(__dirname, '../..');
        assert.ok(
          saved !== repository && !saved.startsWith(repository + path.sep),
          'raw evidence must stay outside the repository'
        );
        await fs.mkdir(path.dirname(saved), { recursive: true });
        await fs.writeFile(saved, JSON.stringify(report, null, 2));
      }
      console.log(JSON.stringify({ name, retainedRuns: data.runs.length, verifiedObjects: data.expectedObjects }));
    } finally {
      if (server) {
        server.disconnect();
        server.kill();
      }
    }
  }
  console.log(`Evidence: ${path.join(temporary, 'results.json')}`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
