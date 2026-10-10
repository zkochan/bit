// Kernel-only dispatch comparison; canonical merge/index work is measured by import-qualification.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const zlib = require('node:zlib');
const { source, root } = require('./load-source.cjs');
const { RustObjectImporter } = source('components/legacy/scope/objects-fetcher/rust-object-importer.ts');
assert.ok(
  process.argv[2] && process.argv[3] && process.argv[4],
  'usage: mutable-crossover.cjs BASELINE CANDIDATE REPORT'
);
const helpers = process.argv.slice(2, 4).map((value) => path.resolve(value));
const output = path.resolve(process.argv[4]);
const rounds = Number(process.env.BIT_MUTABLE_CROSSOVER_ROUNDS || 5);
const frames = Number(process.env.BIT_MUTABLE_CROSSOVER_FRAMES || 4096);
const scratch = path.resolve(process.env.BIT_MUTABLE_CROSSOVER_TMPDIR || os.tmpdir());
const sha = (value) => createHash('sha256').update(value).digest('hex');
const outside = (value) => value !== root && !value.startsWith(root + path.sep);
assert.equal(process.platform, 'linux', 'CPU measurements require Linux /proc');
assert.ok(helpers.length === 2 && process.argv[4], 'usage: mutable-crossover.cjs BASELINE CANDIDATE REPORT');
assert.ok(outside(output) && outside(scratch), 'generated evidence must stay outside Git');
assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 20);
assert.ok(Number.isInteger(frames) && frames >= 1 && frames <= 8192);
const ticks = Number(cp.execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
async function helperCpu(pid) {
  const line = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
  const fields = line
    .slice(line.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/);
  return (Number(fields[11]) + Number(fields[12])) / ticks;
}
const parentCpu = () => {
  const usage = process.resourceUsage();
  return (usage.userCPUTime + usage.systemCPUTime) / 1e6;
};
(async () => {
  await fs.mkdir(scratch, { recursive: true });
  await fs.mkdir(path.dirname(output), { recursive: true });
  const temporary = await fs.mkdtemp(path.join(scratch, 'bit-mutable-crossover-'));
  const hashes = await Promise.all(helpers.map(async (helper) => sha(await fs.readFile(helper))));
  const report = {
    schemaVersion: 1,
    rounds,
    frames,
    harnessSha256: sha(await fs.readFile(__filename)),
    candidateStoreSourceSha256: sha(await fs.readFile(path.join(root, 'native/object-import/src/mutable_store.rs'))),
    node: process.version,
    filesystemType: (await fs.statfs(temporary)).type,
    cpuTickSeconds: 1 / ticks,
    helperSha256: hashes,
    clientSha256: sha(
      await fs.readFile(path.join(root, 'components/legacy/scope/objects-fetcher/rust-object-importer.ts'))
    ),
    cases: {},
  };
  try {
    for (const bytes of [1024, 8192, 128 * 1024]) {
      for (const count of [1, 2, 4, 8]) {
        const body = Buffer.from(JSON.stringify({ data: 'abcd'.repeat(bytes / 4) }));
        const frameCount = Math.min(frames, Math.floor((64 * 1024 * 1024) / (count * (bytes + 128))));
        const inputs = Array.from({ length: frameCount }, (_, frame) =>
          Array.from({ length: count }, (_, index) => {
            const hash = createHash('sha1').update(`${bytes}:${count}:${frame}:${index}`).digest('hex');
            return {
              ref: { toString: () => hash },
              buffer: Buffer.concat([Buffer.from(`Version ${hash} ${body.length}\0`), body]),
            };
          })
        );
        const values = (report.cases[`${count}x${bytes}`] = {
          count,
          frames: frameCount,
          bodyBytes: body.length,
          runs: [],
        });
        for (let round = -1; round < rounds; round++) {
          for (let offset = 0; offset < 2; offset++) {
            const mode = (offset + Math.max(round, 0)) % 2;
            const directory = await fs.mkdtemp(path.join(temporary, 'run-'));
            const writer = new RustObjectImporter(helpers[mode], { objectsDirectory: directory });
            try {
              for (let warm = 0; warm < 8; warm++) await writer.persistMetadata(inputs[0]);
              const nativeStart = await helperCpu(writer.child.pid);
              const parentStart = parentCpu();
              const started = performance.now();
              for (const objects of inputs) {
                const sizes = await writer.persistMetadata(objects);
                assert.ok(sizes?.length === count && sizes.every((size) => size > 0));
              }
              const elapsedMs = performance.now() - started;
              const cpuSeconds = parentCpu() - parentStart + (await helperCpu(writer.child.pid)) - nativeStart;
              assert.equal(writer.stats.mutableFallbacks, 0);
              for (const objects of inputs)
                for (const object of objects) {
                  const hash = object.ref.toString();
                  assert.deepEqual(
                    zlib.inflateSync(await fs.readFile(path.join(directory, hash.slice(0, 2), hash.slice(2)))),
                    object.buffer
                  );
                }
              if (round >= 0) values.runs.push({ round, mode, elapsedMs, cpuSeconds });
            } finally {
              await writer.disposeAndWait();
              await fs.rm(directory, { recursive: true, force: true });
            }
            global.gc?.();
          }
        }
        await fs.writeFile(output, JSON.stringify(report, null, 2));
        console.log(JSON.stringify({ count, bytes, retainedRuns: values.runs.length }));
      }
    }
    assert.deepEqual(
      await Promise.all(helpers.map(async (helper) => sha(await fs.readFile(helper)))),
      hashes,
      'helper changed during crossover measurement'
    );
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
