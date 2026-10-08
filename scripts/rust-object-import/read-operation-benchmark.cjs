// Actual compiled APIs; generated fixtures/reports remain outside Git.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createRequire } = require('node:module');
const { performance } = require('node:perf_hooks');
const { createHook } = require('node:async_hooks');
const root = path.resolve(__dirname, '../..');
const cli = process.env.BIT_LEGACY_ROOT;
const report = process.env.BIT_READ_OPERATION_REPORT;
assert.ok(cli && path.isAbsolute(cli), 'select the rebuilt private CLI');
assert.ok(report && path.isAbsolute(report) && !report.startsWith(root + path.sep));
const { Repository, Ref } = createRequire(path.join(cli, 'package.json'))('@teambit/objects');
const helper = process.env.BIT_TEST_OBJECT_IMPORT || path.join(root, 'native/target/release/bit-object-import');
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
(async () => {
  const directory = await fs.mkdtemp(
    path.join(process.env.BIT_READ_OPERATION_TMPDIR || os.tmpdir(), 'bit-read-operation-')
  );
  try {
    const repo = new Repository(directory, { name: 'operation-benchmark' });
    repo.getPath = () => directory;
    const refs = Array.from({ length: 16384 }, (_, i) => new Ref(i.toString(16).padStart(40, '0')));
    const bytes = zlib.deflateSync(Buffer.from('Source hash 1\0fixture'));
    await fs.mkdir(path.join(directory, '00'));
    for (let offset = 0; offset < refs.length; offset += 128)
      await Promise.all(refs.slice(offset, offset + 128).map((ref) => fs.writeFile(repo.objectPath(ref), bytes)));
    const cases = [];
    process.env.BIT_RUST_OBJECT_IMPORT = helper;
    process.env.BIT_RUST_OBJECT_TRAVERSAL = 'off';
    for (const count of [4096, 16384]) {
      const input = refs.slice(0, count);
      repo.listRefs = async () => input;
      for (const operation of ['exists', 'headers']) {
        const run = async () => {
          if (operation === 'exists') assert.deepEqual(await repo.hasMultiple(input), input);
          else {
            const result = await repo.listObjectsWithType();
            assert.equal(result.unreadable.length, 0);
            assert.equal(result.objects.length, count);
            assert.ok(
              result.objects.every(
                (object, i) => object.ref === input[i] && object.type === 'Source' && object.size === bytes.length
              )
            );
          }
        };
        const timings = { previous: [], grouped: [] };
        for (let round = -1; round < 9; round++) {
          for (const mode of round % 2 ? ['grouped', 'previous'] : ['previous', 'grouped']) {
            process.env.BIT_RUST_OBJECT_READ_OPERATIONS = mode === 'previous' ? 'off' : 'on';
            global.gc?.();
            const start = performance.now();
            await run();
            if (round >= 0) timings[mode].push(performance.now() - start);
          }
        }
        const resources = {};
        for (const mode of ['previous', 'grouped']) {
          const counts = { helpers: 0, filesystemRequests: 0 };
          const hook = createHook({
            init(_, type) {
              if (type === 'PROCESSWRAP') counts.helpers++;
              if (type.startsWith('FSREQ')) counts.filesystemRequests++;
            },
          });
          process.env.BIT_RUST_OBJECT_READ_OPERATIONS = mode === 'previous' ? 'off' : 'on';
          hook.enable();
          try {
            await run();
          } finally {
            hook.disable();
          }
          assert.equal(counts.helpers, Math.ceil(count / (mode === 'previous' ? 4096 : 16384)));
          assert.equal(counts.filesystemRequests, 0);
          resources[mode] = counts;
        }
        cases.push({
          operation,
          count,
          timings,
          mediansMs: Object.fromEntries(Object.entries(timings).map(([mode, values]) => [mode, median(values)])),
          resources,
        });
      }
    }
    const profile = await require('./directory-profile.cjs')(directory, refs.length, helper, {
      flag: 'BIT_RUST_OBJECT_READ_OPERATIONS',
      nativeMode: 'grouped',
      worker: 'read-operation-profile-worker.cjs',
    });
    await fs.writeFile(
      report,
      JSON.stringify(
        { node: process.version, filesystemType: (await fs.statfs(directory)).type, rounds: 9, cases, profile },
        null,
        2
      )
    );
    console.log(
      JSON.stringify(
        cases.map(({ operation, count, mediansMs, resources }) => ({ operation, count, mediansMs, resources }))
      )
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
