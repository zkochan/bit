// Actual compiled decoder versus staged kernel over same-worker loopback HTTP.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { fixtures } = require('./tar-fixtures.cjs');
const [cli, candidate] = process.argv.slice(2).map((value) => path.resolve(value));
(async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-tar-http-parity-'));
  const report = { cli, candidate, scratch, transport: 'same-worker loopback HTTP', cases: {} };
  try {
    for (const [name, buffer] of Object.entries(await fixtures())) {
      const archive = path.join(scratch, name + '.tar');
      await fs.writeFile(archive, buffer);
      const run = (mode) => {
        const result = cp.spawnSync(
          process.execPath,
          [path.join(__dirname, 'tar-intake-worker.cjs'), cli, mode, archive, candidate],
          {
            env: { ...process.env, BIT_LEGACY_ROOT: cli, BIT_TAR_QUALIFICATION_TRANSPORT: 'http' },
            encoding: 'utf8',
            timeout: 15000,
            maxBuffer: 2 * 1024 * 1024,
          }
        );
        assert.equal(result.status, 0, `${name}: ${result.stderr || result.error}`);
        return JSON.parse(result.stdout);
      };
      const canonical = run('probe');
      const native = run('native-probe');
      assert.deepEqual(native.entries, canonical.entries, `${name}: ordered entries`);
      assert.equal(native.error, canonical.error, `${name}: host error`);
      assert.equal(native.done === true, !canonical.error, `${name}: completion`);
      if (!canonical.error) assert.equal(native.count, canonical.count, `${name}: count`);
      report.cases[name] = { canonical, native };
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
