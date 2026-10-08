// Generated fixtures and raw measurements belong outside Git.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createHook } = require('node:async_hooks');
const { root, source, installed } = require('./load-source.cjs');
const { default: Repository } = source('scopes/scope/objects/objects/repository.ts');
const { Ref } = installed('@teambit/objects');
const native = process.env.BIT_TEST_OBJECT_IMPORT || path.join(root, 'native/target/release/bit-object-import');
const report = process.env.BIT_INVENTORY_REPORT;
assert.ok(report && path.isAbsolute(report), 'BIT_INVENTORY_REPORT must name an external absolute output');
assert.ok(!report.startsWith(root + path.sep));
const sizes = [256, 1024, 4096, 16384];
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
(async () => {
  const directory = await fs.mkdtemp(
    path.join(process.env.BIT_INVENTORY_TMPDIR || os.tmpdir(), 'bit-inventory-bench-')
  );
  const refs = Array.from({ length: sizes.at(-1) }, (_, i) => new Ref(i.toString(16).padStart(40, '0')));
  const repo = Object.create(Repository.prototype);
  repo.getPath = () => directory;
  await fs.mkdir(path.join(directory, '00'));
  for (let offset = 0; offset < refs.length; offset += 128) {
    await Promise.all(
      refs
        .slice(offset, offset + 128)
        .filter((_, i) => i % 2 === 0)
        .map((ref) => fs.writeFile(repo.objectPath(ref), 'fixture'))
    );
  }
  const cases = [];
  for (const size of sizes) {
    const input = refs.slice(0, size);
    const timings = { node: [], native: [] };
    for (let round = -1; round < 9; round++) {
      for (const mode of round % 2 ? ['native', 'node'] : ['node', 'native']) {
        process.env.BIT_RUST_OBJECT_IMPORT = mode === 'native' ? native : 'off';
        const start = performance.now();
        const existing = await repo.hasMultiple(input);
        const elapsed = performance.now() - start;
        assert.deepEqual(
          existing,
          input.filter((_, i) => i % 2 === 0)
        );
        if (round >= 0) timings[mode].push(elapsed);
      }
    }
    const callbacks = {};
    for (const mode of ['node', 'native']) {
      let count = 0;
      const hook = createHook({
        init(_, type) {
          if (type.startsWith('FSREQ')) count++;
        },
      });
      process.env.BIT_RUST_OBJECT_IMPORT = mode === 'native' ? native : 'off';
      hook.enable();
      await repo.hasMultiple(input);
      hook.disable();
      callbacks[mode] = count;
    }
    cases.push({
      size,
      timings,
      mediansMs: Object.fromEntries(Object.entries(timings).map(([mode, values]) => [mode, median(values)])),
      nodeFilesystemRequests: callbacks,
    });
  }
  await fs.writeFile(
    report,
    JSON.stringify(
      { node: process.version, filesystemType: (await fs.statfs(directory)).type, rounds: 9, helper: native, cases },
      null,
      2
    )
  );
  console.log(
    JSON.stringify(
      cases.map(({ size, mediansMs, nodeFilesystemRequests }) => ({ size, mediansMs, nodeFilesystemRequests }))
    )
  );
  await fs.rm(directory, { recursive: true, force: true });
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
