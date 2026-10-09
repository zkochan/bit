// Qualification adapter for the experimental kernel; archive staging belongs outside the repository.
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { withStagedArchive } = require('./tar-staging.cjs');
const { readTarBatches } = require('./tar-batch-client.cjs');
const native =
  process.env.BIT_TEST_OBJECT_IMPORT ||
  path.resolve(__dirname, '../../native/target/debug/bit-object-import' + (process.platform === 'win32' ? '.exe' : ''));
async function processArchive(archive, mode, directory, options = {}) {
  let start,
    end,
    objects = 0;
  const started = performance.now();
  const stats = await readTarBatches(
    native,
    archive,
    { ...options, digest: mode === 'probe', objectsDirectory: mode === 'store' ? directory : undefined },
    async (files) => {
      const selected = [];
      let error;
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        try {
          if (file.name === '.BIT.START') {
            start = JSON.parse(file.text);
            continue;
          }
          if (file.name === '.BIT.END') {
            end = JSON.parse(file.text);
            continue;
          }
          if (file.name === '.BIT.ERROR') throw new Error(file.text);
          const [scope, hash] = file.name.split('/');
          const ref = hash ?? scope;
          if (!ref) throw new Error('failed creating a Ref object, the hash argument is empty');
          objects++;
          if (mode === 'probe') {
            const entry = {
              name: hash === undefined ? scope : scope ? `${scope}/${hash}` : hash,
              size: file.size,
              sha1: file.sha1,
            };
            if (options.onEntry) options.onEntry(entry);
            else process.stdout.write(JSON.stringify(entry) + '\n');
          }
          if (mode === 'store' && file.validation?.status === 'source') selected.push(index);
        } catch (cause) {
          error = cause;
          break;
        }
      }
      return { selected, error };
    }
  );
  if (start?.schema === '1.0.0' && !end)
    throw new Error(`server terminated the stream unexpectedly (metadata: ${JSON.stringify(start)})`);
  return {
    done: true,
    count: objects,
    sources: stats.persisted,
    batches: stats.batches,
    elapsedMs: performance.now() - started,
  };
}
async function main() {
  const [mode, directory] = process.argv.slice(2);
  const result = await withStagedArchive(process.stdin, {}, ({ archive, signal }) =>
    processArchive(archive, mode, directory, { signal })
  );
  console.log(JSON.stringify(result));
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { processArchive };
