// Kernel-only dispatch comparison; canonical merge/index work is measured by import-qualification.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const zlib = require('node:zlib');
const { createRequire } = require('node:module');
const { createFixture } = require('./scope-fixture.cjs');
const { benchmarkGlobals } = require('../rust-dependency-analysis/command-workspace.cjs');
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
const selectedCases = process.env.BIT_MUTABLE_CROSSOVER_CASES?.split(',');
const realCli = process.env.BIT_MUTABLE_CROSSOVER_REAL_CLI;
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
  process.env.BIT_GLOBALS_DIR = benchmarkGlobals(temporary);
  const hashes = await Promise.all(helpers.map(async (helper) => sha(await fs.readFile(helper))));
  const cases = [];
  for (const bytes of [1024, 8192, 128 * 1024])
    for (const count of [1, 2, 3, 4, 8]) cases.push({ name: `${count}x${bytes}`, count, bytes });
  let realCliProvenance;
  let checkRealCli = async () => {};
  if (realCli) {
    realCliProvenance = JSON.parse(await fs.readFile(path.join(realCli, '.bit-object-import-build.json')));
    checkRealCli = async () => {
      for (const file of realCliProvenance.compiledModules)
        assert.equal(sha(await fs.readFile(path.join(realCli, 'node_modules/@teambit', file.path))), file.sha256);
    };
    await checkRealCli();
    const manifest = await createFixture(realCli, path.join(temporary, 'real-remotes'), {
      components: 1,
      files: 1,
      bytes: 1024,
      versions: 8,
    });
    const load = createRequire(path.join(realCli, 'package.json'));
    const { Scope } = load('@teambit/legacy.scope');
    const { Ref, Version, VersionHistory } = load('@teambit/objects');
    const scope = await Scope.load(path.join(temporary, 'real-remotes', 'qualification.remote0'), false);
    const expected = Object.values(manifest.components)[0];
    const model = await scope.objects.load(new Ref(expected.hash));
    const version = await scope.objects.load(model.versions['1.0.0']);
    const history = await scope.objects.load(
      new Ref(Object.entries(manifest.hashes).find(([, value]) => value.type === 'VersionHistory')[0])
    );
    const versionBody = version.toBuffer().toString();
    const historyBody = history.toBuffer().toString();
    for (const mixed of [false, true]) {
      cases.push({
        name: mixed ? '3xreal-history' : '3xreal-version',
        count: 3,
        bytes: 2048,
        generate(frame, index) {
          let object;
          if (mixed && index === 2) {
            object = VersionHistory.parse(historyBody);
            object.name += `-${frame}`;
          } else {
            object = Version.parse(versionBody, version.hash().toString());
            object.log.message += `-${frame}-${index}`;
            object._hash = object.calculateHash().toString();
          }
          return { ref: object.hash(), buffer: object.serialize() };
        },
      });
    }
    scope.objects.clearObjectsFromCache();
    delete Scope.scopeCache[scope.path];
  }
  if (selectedCases)
    for (const name of selectedCases)
      assert.ok(
        cases.some((value) => value.name === name),
        `unknown case ${name}`
      );
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
    realCliProvenance,
    cases: {},
  };
  try {
    for (const { name, bytes, count, generate } of cases) {
      if (selectedCases && !selectedCases.includes(name)) continue;
      const body = Buffer.from(JSON.stringify({ data: 'abcd'.repeat(bytes / 4) }));
      const frameCount = Math.min(frames, Math.floor((64 * 1024 * 1024) / (count * (bytes + 128))));
      const inputs = Array.from({ length: frameCount }, (_, frame) =>
        Array.from({ length: count }, (_, index) => {
          if (generate) return generate(frame, index);
          const hash = createHash('sha1').update(`${bytes}:${count}:${frame}:${index}`).digest('hex');
          return {
            ref: { toString: () => hash },
            buffer: Buffer.concat([Buffer.from(`Version ${hash} ${body.length}\0`), body]),
          };
        })
      );
      const serializedLengths = inputs.map((objects) =>
        objects.reduce((sum, object) => sum + object.buffer.byteLength, 0)
      );
      const values = (report.cases[name] = {
        count,
        frames: frameCount,
        bodyBytes: generate ? undefined : body.length,
        serializedFrameBytes: { min: Math.min(...serializedLengths), max: Math.max(...serializedLengths) },
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
      console.log(JSON.stringify({ name, count, bytes, retainedRuns: values.runs.length }));
    }
    assert.deepEqual(
      await Promise.all(helpers.map(async (helper) => sha(await fs.readFile(helper)))),
      hashes,
      'helper changed during crossover measurement'
    );
    await checkRealCli();
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
