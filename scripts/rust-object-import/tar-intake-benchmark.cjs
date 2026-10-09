// Source-only intake prototype versus the actual decoder plus existing native batch importer.
// This is an operation benchmark, not a full import, merge, cancellation or platform qualification.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { archive, source, start, end } = require('./tar-fixtures.cjs');
const { createProcessTreeMemorySampler } = require('../rust-dependency-analysis/process-tree-memory.cjs');
const { createBenchmarkProcessControl } = require('../rust-dependency-analysis/process-tree-memory-control.cjs');
const [cli, helper, candidate] = process.argv.slice(2).map((arg) => path.resolve(arg));
const transport = process.env.BIT_TAR_QUALIFICATION_TRANSPORT || 'file';
assert.ok(['file', 'http'].includes(transport));
const staged = transport === 'http' || process.env.BIT_TAR_QUALIFICATION_STAGE === '1';
const rounds = Number(process.env.BIT_TAR_QUALIFICATION_ROUNDS || 9);
assert.ok(Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= 99);
assert.equal(process.platform, 'linux', 'whole-process CPU/RSS measurement currently requires Linux');
const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
async function run(mode, input, directory, cpuFile) {
  const args = [
    path.join(__dirname, 'tar-intake-worker.cjs'),
    cli,
    mode,
    input,
    mode === 'control' ? helper : candidate,
    directory,
  ];
  const began = performance.now();
  const child = cp.spawn('/usr/bin/time', ['-f', '%U %S', '-o', cpuFile, process.execPath, ...args], {
    env: { ...process.env, BIT_LEGACY_ROOT: cli, BIT_RUST_OBJECT_IMPORT_METADATA: 'on' },
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
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
  } finally {
    control.dispose();
  }
  const memory = sampler.stop();
  assert.equal(code, 0, stderr);
  const result = JSON.parse(stdout);
  assert.equal(result.error, undefined, stdout);
  const cpu = (await fs.readFile(cpuFile, 'utf8')).trim().split(/\s+/).map(Number);
  return { mode, ...result, commandElapsedMs: performance.now() - began, cpuMs: (cpu[0] + cpu[1]) * 1000, memory };
}
async function verify(directory, items) {
  for (const item of items) {
    const hash = item.name.split('/')[1];
    assert.deepEqual(await fs.readFile(path.join(directory, hash.slice(0, 2), hash.slice(2))), item.buffer);
  }
  let files = 0;
  for (const prefix of await fs.readdir(directory)) files += (await fs.readdir(path.join(directory, prefix))).length;
  assert.equal(files, items.length, 'no unexpected temporary or extra object files');
}
(async () => {
  const root = path.resolve(process.env.BIT_TAR_QUALIFICATION_DIRECTORY || os.tmpdir());
  await fs.mkdir(root, { recursive: true });
  const sourceRoot = await fs.realpath(path.resolve(__dirname, '../..'));
  const physicalRoot = await fs.realpath(root);
  const relative = path.relative(sourceRoot, physicalRoot);
  assert.ok(relative.startsWith('..' + path.sep) || path.isAbsolute(relative), 'evidence must stay outside Git');
  const scratch = await fs.mkdtemp(path.join(root, 'bit-tar-benchmark-'));
  const report = {
    scratch,
    filesystemType: (await fs.statfs(scratch)).type,
    transport,
    staged,
    stagingDirectory: process.env.BIT_TAR_STAGING_DIRECTORY || os.tmpdir(),
    stagingFilesystemType: (await fs.statfs(process.env.BIT_TAR_STAGING_DIRECTORY || os.tmpdir())).type,
    cli,
    rounds,
    node: process.version,
    helperSha256: crypto
      .createHash('sha256')
      .update(await fs.readFile(helper))
      .digest('hex'),
    candidateSha256: crypto
      .createHash('sha256')
      .update(await fs.readFile(candidate))
      .digest('hex'),
    candidateNativeSha256: process.env.BIT_TEST_OBJECT_IMPORT
      ? crypto
          .createHash('sha256')
          .update(await fs.readFile(process.env.BIT_TEST_OBJECT_IMPORT))
          .digest('hex')
      : null,
    candidateClientSha256: candidate.endsWith('.cjs')
      ? crypto
          .createHash('sha256')
          .update(await fs.readFile(path.join(path.dirname(candidate), 'tar-batch-client.cjs')))
          .digest('hex')
      : null,
    boundary: staged
      ? 'Source-only intake including owned staging and optional same-worker loopback HTTP server/client; no Bit HTTP client/merge/index/full-command qualification'
      : 'Pre-staged Source-only archive intake, validation and persistence; no merge/index/HTTP/full-command qualification',
    workerSha256: crypto
      .createHash('sha256')
      .update(await fs.readFile(path.join(__dirname, 'tar-intake-worker.cjs')))
      .digest('hex'),
    loopbackSha256: crypto
      .createHash('sha256')
      .update(await fs.readFile(path.join(__dirname, 'tar-loopback.cjs')))
      .digest('hex'),
    candidateStagingSha256: candidate.endsWith('.cjs')
      ? crypto
          .createHash('sha256')
          .update(await fs.readFile(path.join(path.dirname(candidate), 'tar-staging.cjs')))
          .digest('hex')
      : null,
    cases: {},
  };
  const cases = [
    ['many-small', 4096, 1024],
    ['large-compressible', 32, 8 * 1024 * 1024],
    ['large-binary', 16, 1024 * 1024],
  ];
  const selectedCases = process.env.BIT_TAR_QUALIFICATION_CASES?.split(',');
  assert.ok(
    !selectedCases || selectedCases.every((name) => cases.some(([valid]) => valid === name)),
    'unknown tar workload'
  );
  for (const [name, count, bytes] of cases) {
    if (process.env.BIT_TAR_QUALIFICATION_CASES && !process.env.BIT_TAR_QUALIFICATION_CASES.split(',').includes(name))
      continue;
    const items = Array.from({ length: count }, (_, index) => {
      const buffer = name === 'large-binary' ? crypto.randomBytes(bytes) : Buffer.alloc(bytes, 97);
      buffer.writeUInt32BE(index);
      return source(buffer);
    });
    const contents = await archive([start(), ...items, end(count)]);
    const input = path.join(scratch, name + '.tar');
    await fs.writeFile(input, contents);
    const data = (report.cases[name] = { count, sourceBytes: count * bytes, tarBytes: contents.length, runs: [] });
    for (let round = -1; round < rounds; round++) {
      for (const mode of round % 2 ? ['native', 'control'] : ['control', 'native']) {
        const directory = path.join(scratch, `${name}-${round}-${mode}`);
        await fs.mkdir(directory);
        const result = await run(mode, input, directory, path.join(scratch, `${name}-${round}-${mode}-cpu.txt`));
        assert.equal(result.count, count);
        assert.equal(result.sources, count);
        await verify(directory, items);
        result.objectsVerified = items.length;
        await fs.rm(directory, { recursive: true });
        if (round >= 0) data.runs.push({ round, ...result });
      }
    }
    data.medians = Object.fromEntries(
      ['control', 'native'].map((mode) => {
        const runs = data.runs.filter((run) => run.mode === mode);
        return [
          mode,
          Object.fromEntries(
            ['elapsedMs', 'commandElapsedMs', 'cpuMs']
              .map((metric) => [metric, median(runs.map((run) => run[metric]))])
              .concat([['sampledRssKiB', median(runs.map((run) => run.memory.peakSampledRssKiB))]])
          ),
        ];
      })
    );
    console.error(JSON.stringify({ case: name, medians: data.medians }));
  }
  for (const [file, expected] of [
    [path.join(__dirname, 'tar-intake-worker.cjs'), report.workerSha256],
    [path.join(__dirname, 'tar-loopback.cjs'), report.loopbackSha256],
    [helper, report.helperSha256],
    [candidate, report.candidateSha256],
    [process.env.BIT_TEST_OBJECT_IMPORT, report.candidateNativeSha256],
    [
      candidate.endsWith('.cjs') && path.join(path.dirname(candidate), 'tar-batch-client.cjs'),
      report.candidateClientSha256,
    ],
    [
      candidate.endsWith('.cjs') && path.join(path.dirname(candidate), 'tar-staging.cjs'),
      report.candidateStagingSha256,
    ],
  ]) {
    if (file && expected)
      assert.equal(
        crypto
          .createHash('sha256')
          .update(await fs.readFile(file))
          .digest('hex'),
        expected,
        'benchmark source changed during measurement'
      );
  }
  console.log(JSON.stringify(report, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
