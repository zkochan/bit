const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { createProcessTreeMemorySampler } = require('../rust-dependency-analysis/process-tree-memory.cjs');
const { createBenchmarkProcessControl } = require('../rust-dependency-analysis/process-tree-memory-control.cjs');
module.exports = async function profile(directory, count, helper) {
  if (process.platform !== 'linux' || process.env.BIT_DIRECTORY_PROFILE !== '1') return undefined;
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-directory-profile-'));
  const results = { previous: [], traversal: [] };
  try {
    for (let round = -1; round < 9; round++) {
      for (const mode of round % 2 ? ['traversal', 'previous'] : ['previous', 'traversal']) {
        const cpuFile = path.join(temporary, 'cpu.txt');
        const start = performance.now();
        const child = cp.spawn(
          '/usr/bin/time',
          [
            '-f',
            '%U %S',
            '-o',
            cpuFile,
            process.execPath,
            '--expose-gc',
            path.join(__dirname, 'directory-profile-worker.cjs'),
            process.env.BIT_LEGACY_ROOT,
            directory,
            String(count),
            '32',
          ],
          {
            detached: true,
            env: {
              ...process.env,
              BIT_RUST_OBJECT_IMPORT: helper,
              BIT_RUST_OBJECT_TRAVERSAL: mode === 'previous' ? 'off' : 'on',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        );
        const control = createBenchmarkProcessControl(child, { timeoutMs: 60000 });
        const sampler = createProcessTreeMemorySampler(child.pid, { intervalMs: 5 });
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
        const memory = sampler.stop();
        if (control.failure) throw control.failure;
        assert.equal(code, 0, stderr || stdout);
        assert.deepEqual(JSON.parse(stdout), { count, repeats: 32 });
        const cpuSeconds = (await fs.readFile(cpuFile, 'utf8'))
          .trim()
          .split(/\s+/)
          .map(Number)
          .reduce((sum, value) => sum + value, 0);
        if (round >= 0) results[mode].push({ elapsedMs: performance.now() - start, cpuSeconds, memory });
      }
    }
    return { count, repeats: 32, rounds: 9, results };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
};
