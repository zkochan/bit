// Complete compiled Repository inventories; raw evidence and fixtures remain outside Git.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { performance } = require('node:perf_hooks');
const { createHook } = require('node:async_hooks');
const { root, installed } = require('./load-source.cjs');
const { Repository } = installed('@teambit/objects');
const helper = process.env.BIT_TEST_OBJECT_IMPORT || path.join(root, 'native/target/release/bit-object-import');
const report = process.env.BIT_DIRECTORY_REPORT;
assert.ok(report && path.isAbsolute(report) && !report.startsWith(root + path.sep));
assert.ok(
  process.env.BIT_LEGACY_ROOT && path.isAbsolute(process.env.BIT_LEGACY_ROOT),
  'select the rebuilt private CLI with BIT_LEGACY_ROOT'
);
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
(async () => {
  const directory = await fs.mkdtemp(
    path.join(process.env.BIT_DIRECTORY_TMPDIR || os.tmpdir(), 'bit-directory-bench-')
  );
  try {
    const repo = new Repository(directory, { name: 'benchmark' });
    repo.getPath = () => directory;
    const bytes = zlib.deflateSync(Buffer.from('Source hash 1\0fixture'));
    const cases = [];
    let hashes = [];
    for (const count of [256, 4096, 16384]) {
      for (let i = hashes.length; i < count; i++)
        hashes.push(
          (i % 256).toString(16).padStart(2, '0') +
            Math.floor(i / 256)
              .toString(16)
              .padStart(38, '0')
        );
      await Promise.all(
        Array.from({ length: 256 }, (_, i) =>
          fs.mkdir(path.join(directory, i.toString(16).padStart(2, '0')), { recursive: true })
        )
      );
      for (let offset = 0; offset < hashes.length; offset += 128)
        await Promise.all(
          hashes
            .slice(offset, offset + 128)
            .map((hash) => fs.writeFile(path.join(directory, hash.slice(0, 2), hash.slice(2)), bytes))
        );
      const expected = [...hashes].sort();
      for (const operation of ['refs', 'headers']) {
        const run = async () => {
          const result = operation === 'refs' ? await repo.listRefs() : await repo.listObjectsWithType();
          if (operation === 'refs') assert.deepEqual(result.map(String).sort(), expected);
          else {
            assert.equal(result.unreadable.length, 0);
            assert.deepEqual(result.objects.map(({ ref }) => String(ref)).sort(), expected);
            assert.ok(result.objects.every((object) => object.type === 'Source' && object.size === bytes.length));
          }
        };
        const timings = { previous: [], traversal: [] };
        process.env.BIT_RUST_OBJECT_IMPORT = helper;
        for (let round = -1; round < 9; round++) {
          for (const mode of round % 2 ? ['traversal', 'previous'] : ['previous', 'traversal']) {
            process.env.BIT_RUST_OBJECT_TRAVERSAL = mode === 'previous' ? 'off' : 'on';
            global.gc?.();
            const start = performance.now();
            await run();
            if (round >= 0) timings[mode].push(performance.now() - start);
          }
        }
        const callbacks = {};
        for (const mode of ['previous', 'traversal']) {
          let requests = 0;
          const hook = createHook({
            init(_, type) {
              if (type.startsWith('FSREQ')) requests++;
            },
          });
          process.env.BIT_RUST_OBJECT_TRAVERSAL = mode === 'previous' ? 'off' : 'on';
          hook.enable();
          try {
            await run();
          } finally {
            hook.disable();
          }
          if (mode === 'traversal') assert.equal(requests, 1, 'native traversal must actually execute');
          callbacks[mode] = requests;
        }
        cases.push({
          operation,
          count,
          timings,
          mediansMs: Object.fromEntries(Object.entries(timings).map(([mode, values]) => [mode, median(values)])),
          filesystemRequests: callbacks,
        });
      }
    }
    const profile = await require('./directory-profile.cjs')(directory, hashes.length, helper);
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
        cases.map(({ operation, count, mediansMs, filesystemRequests }) => ({
          operation,
          count,
          mediansMs,
          filesystemRequests,
        }))
      )
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
