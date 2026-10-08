// Real Repository APIs; raw evidence/fixtures stay outside Git.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { performance } = require('node:perf_hooks');
const { createHook } = require('node:async_hooks');
const { root, source, installed } = require('./load-source.cjs');
const { default: Repository } = source('scopes/scope/objects/objects/repository.ts');
const { Ref } = installed('@teambit/objects');
const helper = process.env.BIT_TEST_OBJECT_IMPORT || path.join(root, 'native/target/release/bit-object-import');
const report = process.env.BIT_READ_REPORT;
assert.ok(report && path.isAbsolute(report) && !report.startsWith(root + path.sep));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
(async () => {
  const directory = await fs.mkdtemp(path.join(process.env.BIT_READ_TMPDIR || os.tmpdir(), 'bit-read-bench-'));
  const repo = new Repository(directory, { name: 'benchmark' });
  repo.getPath = () => directory;
  const refs = Array.from({ length: 4096 }, (_, index) => new Ref(index.toString(16).padStart(40, '0')));
  const buffer = zlib.deflateSync(Buffer.from('Source hash 1\0fixture'));
  await fs.mkdir(path.join(directory, '00'));
  for (let offset = 0; offset < refs.length; offset += 128)
    await Promise.all(refs.slice(offset, offset + 128).map((ref) => fs.writeFile(repo.objectPath(ref), buffer)));
  const cases = [];
  for (const operation of ['reads', 'headers']) {
    for (const count of [1024, 4096]) {
      const input = refs.slice(0, count);
      repo.listRefs = async () => input;
      const run = async () => {
        if (operation === 'reads') {
          const objects = await repo.loadManyRaw(input);
          assert.equal(objects.length, count);
          objects.forEach((object, index) => {
            assert.equal(object.ref, input[index]);
            assert.deepEqual(object.buffer, buffer);
          });
        } else {
          const objects = await repo.listObjectsWithType();
          assert.equal(objects.unreadable.length, 0);
          assert.equal(objects.objects.length, count);
          assert.ok(
            objects.objects.every(
              (object, index) =>
                object.ref === input[index] && object.type === 'Source' && object.size === buffer.length
            )
          );
        }
      };
      const timings = { node: [], native: [] };
      for (let round = -1; round < 9; round++) {
        for (const mode of round % 2 ? ['native', 'node'] : ['node', 'native']) {
          process.env.BIT_RUST_OBJECT_IMPORT = mode === 'native' ? helper : 'off';
          global.gc?.();
          const start = performance.now();
          await run();
          if (round >= 0) timings[mode].push(performance.now() - start);
        }
      }
      const callbacks = {};
      for (const mode of ['node', 'native']) {
        let requests = 0;
        const hook = createHook({
          init(_, type) {
            if (type.startsWith('FSREQ')) requests++;
          },
        });
        process.env.BIT_RUST_OBJECT_IMPORT = mode === 'native' ? helper : 'off';
        hook.enable();
        await run();
        hook.disable();
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
  await fs.writeFile(
    report,
    JSON.stringify(
      { node: process.version, filesystemType: (await fs.statfs(directory)).type, rounds: 9, cases },
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
  await fs.rm(directory, { recursive: true, force: true });
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
