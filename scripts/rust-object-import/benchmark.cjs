// Generated fixtures and raw results stay outside the repository.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { randomBytes, createHash } = require('node:crypto');
const { root: sourceRoot, installedRoot } = require('./load-source.cjs');
const { item } = require('./persistence.cjs');
const { createProcessTreeMemorySampler } = require('../rust-dependency-analysis/process-tree-memory.cjs');
const executable =
  process.env.BIT_TEST_OBJECT_IMPORT || path.resolve(__dirname, '../../native/target/release/bit-object-import');
const rounds = Number(process.env.BIT_IMPORT_BENCH_ROUNDS || 9);
async function run(fixture, directory, mode) {
  const start = performance.now();
  const cpuFile = path.join(directory, 'cpu.txt');
  const child = spawn(
    '/usr/bin/time',
    [
      '-f',
      '%U %S',
      '-o',
      cpuFile,
      process.execPath,
      path.join(__dirname, 'benchmark-worker.cjs'),
      fixture,
      directory,
      mode,
      executable,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const sampler = createProcessTreeMemorySampler(child.pid, { intervalMs: 10 });
  sampler.start();
  const writeSampler = createProcessTreeMemorySampler(child.pid, { intervalMs: 10 });
  writeSampler.start();
  let writeMemory;
  let output = '',
    errors = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
    if (!writeMemory && output.includes('"event":"persisted"')) writeMemory = writeSampler.stop();
  });
  child.stderr.on('data', (chunk) => {
    errors += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  const memory = sampler.stop();
  if (code !== 0) {
    writeSampler.stop();
    throw new Error(errors || `exit ${code}`);
  }
  if (!writeMemory) throw new Error('missing persistence stage event');
  const [userCpuSeconds, systemCpuSeconds] = (await fs.readFile(cpuFile, 'utf8')).trim().split(/\s+/).map(Number);
  return {
    ...JSON.parse(output.trim().split('\n').at(-1)),
    userCpuSeconds,
    systemCpuSeconds,
    writeMemory,
    commandMs: performance.now() - start,
    memory,
  };
}
(async () => {
  if (process.platform !== 'linux') throw new Error('whole process tree measurement requires Linux');
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100) throw new Error('invalid rounds');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-import-benchmark-'));
  const sha256 = async (file) =>
    createHash('sha256')
      .update(await fs.readFile(file))
      .digest('hex');
  const inputs = [
    'components/legacy/scope/objects-fetcher/objects-writable-stream.ts',
    'components/legacy/scope/objects-fetcher/write-objects-queue.ts',
    'components/legacy/scope/objects-fetcher/rust-source-validator.ts',
    'scopes/scope/objects/objects/repository.ts',
    'scripts/rust-object-import/persistence.cjs',
    'scripts/rust-object-import/benchmark-worker.cjs',
  ];
  const sourceSha256 = Object.fromEntries(
    await Promise.all(inputs.map(async (file) => [file, await sha256(path.join(sourceRoot, file))]))
  );
  const results = {
    root,
    platform: process.platform,
    node: process.version,
    rounds,
    sourceRoot,
    installedRoot,
    executable,
    binarySha256: await sha256(executable),
    sourceSha256,
    cases: {},
  };
  for (const [name, count, size, random] of [
    ['many-small', 5000, 1024, false],
    ['large-compressible', 32, 8 * 1024 * 1024, false],
    ['large-binary', 16, 4 * 1024 * 1024, true],
  ]) {
    const fixture = path.join(root, name);
    await fs.mkdir(fixture);
    const hashes = [];
    for (let i = 0; i < count; i++) {
      const contents = random ? randomBytes(size) : Buffer.alloc(size, 97);
      contents.writeUInt32BE(i);
      const obj = await item(contents);
      const hash = obj.ref.toString();
      hashes.push(hash);
      await fs.writeFile(path.join(fixture, hash), obj.buffer);
    }
    await fs.writeFile(path.join(fixture, 'manifest.json'), JSON.stringify({ name, count, size, random, hashes }));
    results.cases[name] = [];
    for (let round = -1; round < rounds; round++) {
      const modes = ['legacy', 'control', 'native'];
      for (let offset = 0; offset < modes.length; offset++) {
        const mode = modes[(offset + Math.max(round, 0)) % modes.length];
        const directory = path.join(root, `${name}-${round}-${mode}`);
        await fs.mkdir(directory);
        const result = await run(fixture, directory, mode);
        if (round >= 0) results.cases[name].push({ round, ...result });
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
    await fs.writeFile(path.join(root, 'results.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ name, results: results.cases[name] }));
  }
  console.log(`Raw evidence: ${path.join(root, 'results.json')}`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
