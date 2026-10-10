// Full production graph regression; lightweight platform CI has no compiled private CLI.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { verifiedArchive } = require('./artifacts/smoke.cjs');
const archive = process.env.BIT_TEST_OBJECT_ARTIFACT;
const cli = process.env.BIT_LEGACY_ROOT;
test(
  'shared HTTP histories preserve canonical arrival order and interrupted prefixes',
  {
    skip: process.platform !== 'linux' || !archive || !cli,
    timeout: 120000,
  },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-shared-http-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const { manifest, members } = verifiedArchive(archive);
    const helper = path.join(directory, manifest.binary.name);
    await fs.writeFile(helper, members[manifest.binary.name], { mode: 0o755 });
    const report = path.join(directory, 'report.json');
    await execFile(process.execPath, [path.join(__dirname, 'shared-http.cjs'), cli, helper, report], {
      env: { ...process.env, BIT_IMPORT_QUALIFICATION_TMPDIR: directory },
      timeout: 110000,
    });
    const result = JSON.parse(await fs.readFile(report));
    assert.equal(result.runs.length, 8);
    for (const run of result.runs) {
      assert.equal(run.code, run.scenario === 'success' ? 0 : 1);
      assert.equal(run.verification.contentsAndModelsVerified, true);
    }
  }
);
