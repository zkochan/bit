// Forced pre-policy fallback and interrupted HTTP parity; raw evidence stays outside Git.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { fixtures } = require('./tar-fixtures.cjs');
const cli = path.resolve(process.argv[2]);
(async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-tar-prefix-parity-'));
  const cases = await fixtures();
  const report = { cli, cases: {}, interrupted: {} };
  try {
    for (const [name, buffer] of Object.entries(cases)) {
      const archive = path.join(scratch, name + '.tar');
      await fs.writeFile(archive, buffer);
      const run = (mode, limit, cut) => {
        const args = [path.join(__dirname, 'tar-prefix-worker.cjs'), cli, mode, archive, String(limit)];
        if (cut !== undefined) args.push(String(cut));
        const result = cp.spawnSync(process.execPath, args, {
          env: { ...process.env, BIT_LEGACY_ROOT: cli },
          encoding: 'utf8',
          timeout: 15000,
          maxBuffer: 2 * 1024 * 1024,
        });
        assert.equal(result.status, 0, `${name}: ${result.error || result.stderr}`);
        return JSON.parse(result.stdout);
      };
      const compare = (limit, cut) => {
        const canonical = run('control', limit, cut);
        const replay = run('staged', limit, cut);
        assert.deepEqual(replay.entries, canonical.entries, `${name}/${cut}: ordered prefix`);
        assert.deepEqual(replay.error, canonical.error, `${name}/${cut}: original error`);
        assert.equal(replay.done, canonical.done, `${name}/${cut}: completion`);
        assert.equal(replay.count, canonical.count, `${name}/${cut}: count`);
        assert.deepEqual(replay.retainedStages, [], `${name}/${cut}: staging cleanup`);
        assert.equal(replay.replayed, 1, `${name}/${cut}: exactly one pre-policy replay`);
        return { canonical, replay };
      };
      report.cases[name] = compare(0);
      if (name === 'normal') {
        for (const cut of [128, 1536, 2112, buffer.length - 1024]) {
          report.interrupted[cut] = compare(2 * 1024 * 1024 * 1024, cut);
        }
      }
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
