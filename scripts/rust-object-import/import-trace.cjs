// Diagnostic preload for the actual compiled importer; never substitutes an implementation.
const fs = require('node:fs');
const Module = require('node:module');
const { createHash } = require('node:crypto');
const output = process.env.BIT_IMPORT_TRACE;
process.env.BIT_IMPORT_TRACE_OWNER ??= String(process.pid);
const owner = Number(process.env.BIT_IMPORT_TRACE_OWNER);
const metrics = {
  schemaVersion: 1,
  stages: {},
  objectTypes: {},
  receivedObjects: 0,
  receivedCompressedBytes: 0,
  native: { instances: 0, submitted: 0, sources: 0, legacy: 0, batches: 0 },
  modules: {},
};
const seen = new WeakMap();
function wrap(target, key, stage, inspect) {
  if (!target || typeof target[key] !== 'function') return;
  let keys = seen.get(target);
  if (!keys) {
    keys = new Set();
    seen.set(target, keys);
  }
  if (keys.has(key)) return;
  keys.add(key);
  const original = target[key];
  target[key] = function (...args) {
    const started = process.hrtime.bigint();
    const record = () => {
      const data = (metrics.stages[stage] ||= { calls: 0, summedInclusiveMs: 0 });
      data.calls++;
      data.summedInclusiveMs += Number(process.hrtime.bigint() - started) / 1e6;
    };
    try {
      const result = original.apply(this, args);
      if (result?.then)
        return result.then(
          (value) => {
            record();
            inspect?.call(this, value, args);
            return value;
          },
          (error) => {
            record();
            throw error;
          }
        );
      record();
      inspect?.call(this, result, args);
      return result;
    } catch (error) {
      record();
      throw error;
    }
  };
}
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const value = originalLoad.apply(this, arguments);
  if (!output || process.pid !== owner || !/objects|scope|source-validator/.test(request)) return value;
  if (value?.Repository) {
    wrap(value.Repository.prototype, 'writeValidatedSourceToFS', 'nativeAtomicPersistence');
    wrap(value.Repository.prototype, '_writeOne', 'legacyPersistence');
    wrap(value.Repository.prototype, 'writeObjectFile', 'atomicFileWrite');
    wrap(value.Repository.prototype, 'writeRemoteLanes', 'remoteLanePersistence');
  }
  if (value?.BitObject)
    wrap(value.BitObject, 'parseObjectWithSize', 'legacyParse', function (result) {
      const type = result.object.getType();
      metrics.objectTypes[type] = (metrics.objectTypes[type] || 0) + 1;
    });
  if (value?.ObjectsWritable)
    wrap(value.ObjectsWritable.prototype, 'writeObjectToFs', 'streamObjectProcessing', function (_, args) {
      metrics.receivedObjects++;
      metrics.receivedCompressedBytes += args[0].buffer.length;
    });
  if (value?.ObjectFetcher) {
    wrap(value.ObjectFetcher.prototype, 'fetchFromRemoteAndWrite', 'fetchAndPersistOperation');
    wrap(value.ObjectFetcher.prototype, 'fetchFromSingleRemote', 'remoteFetchUntilStream');
    wrap(value.ObjectFetcher.prototype, 'mergeAndPersistComponents', 'componentMergeAndIndex');
  }
  if (value?.RustSourceValidator) {
    wrap(value.RustSourceValidator.prototype, 'validate', 'nativeValidation');
    wrap(value.RustSourceValidator.prototype, 'dispose', 'helperDisposal', function () {
      metrics.native.instances++;
      for (const key of ['submitted', 'sources', 'legacy', 'batches']) metrics.native[key] += this.stats[key];
    });
  }
  if (value?.ObjectFetcher || value?.RustSourceValidator || value?.ObjectsWritable) {
    const file = Module._resolveFilename(request, parent);
    if (!metrics.modules[file])
      metrics.modules[file] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  return value;
};
process.on('exit', () => {
  if (output && process.pid === owner) fs.writeFileSync(output, JSON.stringify(metrics, null, 2));
});
