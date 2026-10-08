// Compare the actual compiled tar decoder with an external candidate; evidence stays outside Git.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { fixtures } = require('./tar-fixtures.cjs');
const cli = path.resolve(process.argv[2]);
const candidate = process.argv[3] && path.resolve(process.argv[3]);
(async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-tar-qualification-'));
  const report = { cli, candidate, scratch, cases: {} };
  for (const [name, buffer] of Object.entries(await fixtures())) {
    const archive = path.join(scratch, name + '.tar');
    await fs.writeFile(archive, buffer);
    const canonical = cp.spawnSync(
      process.execPath,
      [path.join(__dirname, 'tar-intake-worker.cjs'), cli, 'probe', archive],
      {
        env: { ...process.env, BIT_LEGACY_ROOT: cli },
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 2 * 1024 * 1024,
      }
    );
    assert.equal(canonical.status, 0, `${name}: ${canonical.stderr || canonical.error}`);
    const actual = JSON.parse(canonical.stdout);
    const result = (report.cases[name] = { canonical: actual });
    if (candidate) {
      const native = cp.spawnSync(candidate, ['probe'], {
        input: buffer,
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 2 * 1024 * 1024,
      });
      if (native.error) throw native.error;
      const responses = native.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
      const entries = responses
        .filter((response) => !response.done)
        .map(({ name, size, sha1 }) => {
          const [scope, hash] = name.split('/');
          return { name: hash === undefined ? scope : scope ? `${scope}/${hash}` : hash, size, sha1 };
        });
      result.native = {
        entries,
        status: native.status,
        error: native.stderr.trim(),
        done: responses.at(-1)?.done === true,
        completionCount: responses.filter((response) => response.done === true).length,
      };
      result.entryParity = JSON.stringify(entries) === JSON.stringify(actual.entries);
      result.errorParity = actual.error
        ? native.status !== 0 && result.native.completionCount === 0 && native.stderr.trim() === actual.error
        : native.status === 0 &&
          result.native.done &&
          result.native.completionCount === 1 &&
          responses.at(-1).count === entries.length;
    }
  }
  assert.equal(report.cases.normal.canonical.entries.length, 4);
  assert.equal(report.cases['gnu-long-name'].canonical.count, 1);
  assert.equal(report.cases['pax-long-name'].canonical.count, 1);
  assert.equal(report.cases['unchecked-end-count'].canonical.count, 4);
  assert.equal(
    report.cases['missing-end'].canonical.error,
    'server terminated the stream unexpectedly (metadata: {"schema":"1.0.0","scopeName":"fixture"})'
  );
  assert.equal(report.cases['remote-error'].canonical.error, 'remote failed: 日本語');
  assert.equal(report.cases['unknown-members'].canonical.entries[0].name, 'unexpected/path');
  assert.equal(report.cases['concatenated-archives'].canonical.count, 2);
  report.mismatches = Object.entries(report.cases)
    .filter(([, value]) => candidate && (!value.entryParity || !value.errorParity))
    .map(([name]) => name);
  console.log(JSON.stringify(report, null, 2));
  if (report.mismatches.length && process.env.BIT_TAR_QUALIFICATION_ALLOW_MISMATCH !== '1') process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
