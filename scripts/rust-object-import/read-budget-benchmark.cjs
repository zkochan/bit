// Actual compiled Repository calls. Generated inputs/results stay outside the checkout.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { performance } = require('node:perf_hooks');
const { createHook } = require('node:async_hooks');
const { createHash } = require('node:crypto');
const profile = require('./directory-profile.cjs');
const cli = process.env.BIT_LEGACY_ROOT;
const helper = process.env.BIT_TEST_OBJECT_IMPORT;
const report = process.env.BIT_READ_BUDGET_REPORT;
const root = path.resolve(__dirname, '../..');
assert.ok(cli && helper && report && path.isAbsolute(report) && !report.startsWith(root + path.sep));
const { Repository, Ref } = createRequire(path.join(cli, 'package.json'))('@teambit/objects');
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
(async () => {
  const directory = await fs.mkdtemp(path.join(process.env.BIT_READ_BUDGET_TMPDIR || os.tmpdir(), 'bit-read-budget-'));
  const cases = [];
  try {
    await fs.mkdir(path.join(directory, '00'));
    const repo = new Repository(directory, { name: 'read-budget-benchmark' });
    repo.getPath = () => directory;
    const refs = Array.from({ length: 1024 }, (_, i) => new Ref(i.toString(16).padStart(40, '0')));
    for (const bytes of [64, 1024, 4096, 16 * 1024, 64 * 1024, 512 * 1024]) {
      const content = Buffer.alloc(bytes, 17);
      const digest = createHash('sha256').update(content).digest('hex');
      for (let i = 0; i < refs.length; i += 32)
        await Promise.all(refs.slice(i, i + 32).map((ref) => fs.writeFile(repo.objectPath(ref), content)));
      const timings = { node: [], previous: [], checked: [] };
      const run = async (mode, verify = true) => {
        process.env.BIT_RUST_OBJECT_IMPORT = mode === 'node' ? 'off' : helper;
        process.env.BIT_RUST_OBJECT_READ_BUDGET = mode === 'checked' ? 'on' : 'off';
        const start = performance.now();
        const result = await repo.loadManyRaw(refs);
        const elapsed = performance.now() - start;
        assert.equal(result.length, refs.length);
        result.forEach((object, index) => {
          assert.equal(object.ref, refs[index]);
          assert.equal(object.buffer.length, bytes);
          if (verify) assert.equal(createHash('sha256').update(object.buffer).digest('hex'), digest);
        });
        return elapsed;
      };
      for (let round = -1; round < 9; round++) {
        for (const mode of round % 2 ? ['checked', 'previous', 'node'] : ['node', 'previous', 'checked']) {
          global.gc?.();
          const elapsed = await run(mode);
          if (round >= 0) timings[mode].push(elapsed);
        }
      }
      const resources = {};
      for (const mode of Object.keys(timings)) {
        const counts = { helpers: 0, filesystemRequests: 0 };
        const hook = createHook({
          init(_, type) {
            if (type === 'PROCESSWRAP') counts.helpers++;
            if (type.startsWith('FSREQ')) counts.filesystemRequests++;
          },
        });
        hook.enable();
        try {
          await run(mode);
        } finally {
          hook.disable();
        }
        resources[mode] = counts;
      }
      const processProfile =
        bytes === 64 * 1024
          ? await profile(directory, refs.length, helper, {
              nativeMode: 'checked',
              flag: 'BIT_RUST_OBJECT_READ_BUDGET',
              worker: 'read-budget-profile-worker.cjs',
            })
          : undefined;
      cases.push({
        processProfile,
        bytes,
        count: refs.length,
        timings,
        mediansMs: Object.fromEntries(Object.entries(timings).map(([mode, values]) => [mode, median(values)])),
        resources,
      });
    }
    await fs.writeFile(
      report,
      JSON.stringify(
        {
          node: process.version,
          filesystem: directory,
          helperSha256: createHash('sha256')
            .update(await fs.readFile(helper))
            .digest('hex'),
          compiledReaderSha256: createHash('sha256')
            .update(
              await fs.readFile(path.join(cli, 'node_modules/@teambit/objects/dist/objects/rust-object-reader.js'))
            )
            .digest('hex'),
          cases,
        },
        null,
        2
      ) + '\n'
    );
    console.log(JSON.stringify(cases.map(({ bytes, mediansMs, resources }) => ({ bytes, mediansMs, resources }))));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
