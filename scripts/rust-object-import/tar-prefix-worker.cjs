// Compare pre-policy replay with the actual compiled decoder in a disposable process.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { withStagedArchive } = require('./tar-staging.cjs');
const { processArchive } = require('./tar-batch-worker.cjs');
const { openLoopbackArchive } = require('./tar-loopback.cjs');
const [cli, mode, archive, limit, cut] = process.argv.slice(2);
const { ObjectList } = createRequire(path.join(cli, 'package.json'))('@teambit/objects');
const entries = [];
let rejectProbe;
process.on('uncaughtException', (error) => {
  if (rejectProbe) rejectProbe(error);
  else throw error;
});
async function probe(input) {
  const stream = ObjectList.fromTarToObjectStream(input);
  try {
    await new Promise((resolve, reject) => {
      rejectProbe = reject;
      stream.on('data', (object) =>
        entries.push({
          name: ObjectList.combineScopeAndHash(object),
          size: object.buffer.length,
          sha1: crypto.createHash('sha1').update(object.buffer).digest('hex'),
        })
      );
      stream.on('error', reject);
      stream.once('end', resolve);
    });
    return { done: true, count: entries.length };
  } finally {
    rejectProbe = undefined;
    stream.destroy();
  }
}
(async () => {
  let input,
    close,
    replayed = 0,
    error,
    result;
  try {
    if (cut !== undefined) {
      const transport = await openLoopbackArchive(archive, { abortAfterBytes: Number(cut) });
      input = transport.stream;
      close = transport.close;
    } else input = fs.createReadStream(archive);
    result =
      mode === 'control'
        ? await probe(input)
        : await withStagedArchive(
            input,
            {
              directory: path.dirname(archive),
              maxBytes: Number(limit),
              replay: async (stream) => {
                replayed++;
                return probe(stream);
              },
            },
            ({ archive, signal }) =>
              processArchive(archive, 'probe', undefined, { signal, onEntry: (entry) => entries.push(entry) })
          );
  } catch (cause) {
    error = { name: cause.name, code: cause.code, message: cause.message };
  } finally {
    input?.destroy();
    await close?.();
  }
  const retainedStages = (await fs.promises.readdir(path.dirname(archive))).filter((name) =>
    name.startsWith('bit-tar-stage-')
  );
  console.log(
    JSON.stringify({ entries, error, done: result?.done === true, count: result?.count, replayed, retainedStages })
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
