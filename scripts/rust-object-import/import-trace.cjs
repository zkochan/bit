// Diagnostic preload for the actual compiled importer; never substitutes an implementation.
const fs = require('node:fs');
const Module = require('node:module');
const { createHash } = require('node:crypto');
const output = process.env.BIT_IMPORT_TRACE;
process.env.BIT_IMPORT_TRACE_OWNER ??= String(process.pid);
const owner = Number(process.env.BIT_IMPORT_TRACE_OWNER);
const asyncHooks = require('node:async_hooks');
const asyncTypes = new Map();
const metrics = {
  schemaVersion: 1,
  stages: {},
  asyncResources: {},
  objectTypes: {},
  lookupResults: { repository: { found: 0, missing: 0 }, component: { found: 0, missing: 0 } },
  inflation: { incoming: 0, repository: 0 },
  receivedObjects: 0,
  receivedCompressedBytes: 0,
  native: {
    instances: 0,
    submitted: 0,
    sources: 0,
    legacy: 0,
    batches: 0,
    metadata: 0,
    persisted: 0,
    writeFallbacks: 0,
    mutableBatches: 0,
    mutableSubmitted: 0,
    mutablePersisted: 0,
    mutableFallbacks: 0,
  },
  tar: { operations: 0, objects: 0, nativeSources: 0, fallbacks: 0, batches: 0 },
  modules: {},
};
if (output && process.pid === owner)
  asyncHooks
    .createHook({
      init(id, type) {
        if (!['FSREQCALLBACK', 'FSREQPROMISE', 'ZLIB', 'WRITEWRAP', 'PROMISE'].includes(type)) return;
        asyncTypes.set(id, type);
        (metrics.asyncResources[type] ||= { created: 0, callbacks: 0 }).created++;
      },
      before(id) {
        const type = asyncTypes.get(id);
        if (type) metrics.asyncResources[type].callbacks++;
      },
      destroy(id) {
        asyncTypes.delete(id);
      },
    })
    .enable();
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
  if (
    !output ||
    process.pid !== owner ||
    !/objects|scope|repositories|component.*merger|remote-lanes|source-validator|object-importer|rust-tar/.test(request)
  )
    return value;
  if (value?.Repository) {
    wrap(value.Repository.prototype, 'load', 'repositoryObjectLoad', function (result) {
      metrics.lookupResults.repository[result ? 'found' : 'missing']++;
    });
    wrap(value.Repository.prototype, 'writeObjectsToTheFS', 'repositoryWriteAndIndex');
    wrap(value.Repository.prototype, 'getNativeSourceStoreEligibility', 'nativeStoreEligibility');
    wrap(value.Repository.prototype, 'getNativeSourceStoreOptions', 'nativeStoreOptions');
    wrap(value.Repository.prototype, 'getChownOptions', 'nativeStoreOwnership');
    wrap(value.Repository.prototype, 'writeValidatedSourceToFS', 'nativeAtomicPersistence');
    wrap(value.Repository.prototype, '_writeOne', 'legacyPersistence');
    wrap(value.Repository.prototype, 'writeObjectFile', 'atomicFileWrite');
    wrap(value.Repository.prototype, 'writeRemoteLanes', 'remoteLanePersistence');
  }
  for (const [name, methods] of Object.entries({
    ScopeIndex: { addMany: 'scopeIndexAdd', write: 'scopeIndexWrite' },
    SourceRepository: { _findComponent: 'existingComponentLookup' },
    MultipleComponentMerger: { merge: 'multipleComponentMerge' },
    ModelComponentMerger: { merge: 'modelComponentMergePolicy' },
    VersionHistory: { merge: 'versionHistoryMergePolicy' },
    LaneHistory: { merge: 'laneHistoryMergePolicy' },
    RemoteLanes: { addEntriesFromModelComponents: 'remoteLaneEntries' },
  })) {
    const target = value?.[name] || (value?.default?.name === name ? value.default : undefined);
    for (const [method, stage] of Object.entries(methods))
      wrap(
        target?.prototype,
        method,
        stage,
        name === 'SourceRepository'
          ? function (result) {
              metrics.lookupResults.component[result ? 'found' : 'missing']++;
            }
          : undefined
      );
  }
  if (value?.BitObject) {
    wrap(value.BitObject, 'parseInflatedObjectWithSize', 'nativeMetadataHydration');
    wrap(value.BitObject, 'parseObjectWithSize', 'legacyParse', function (result, args) {
      metrics.inflation[args[1] === undefined ? 'incoming' : 'repository']++;
      const type = result.object.getType();
      metrics.objectTypes[type] = (metrics.objectTypes[type] || 0) + 1;
    });
  }
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
      if (this.child) metrics.native.instances++;
      for (const key of ['submitted', 'sources', 'legacy', 'batches']) metrics.native[key] += this.stats[key];
    });
  }
  if (value?.RustObjectImporter) {
    wrap(value.RustObjectImporter.prototype, 'importBatch', 'nativeBatchValidationAndPersistence');
    wrap(value.RustObjectImporter.prototype, 'persistMetadata', 'nativeMutableCompressionAndPersistence');
    wrap(value.RustObjectImporter.prototype, 'dispose', 'nativeImporterDisposal', function () {
      if (this.child) metrics.native.instances++;
      for (const key of [
        'submitted',
        'sources',
        'legacy',
        'batches',
        'metadata',
        'persisted',
        'writeFallbacks',
        'mutableSubmitted',
        'mutablePersisted',
        'mutableFallbacks',
      ])
        metrics.native[key] += this.stats[key];
      metrics.native.mutableBatches = (metrics.native.mutableBatches || 0) + (this.stats.mutableBatches || 0);
    });
  }
  if (value?.importTarStream)
    wrap(value, 'importTarStream', 'nativeTarIntake', function (result) {
      metrics.tar.operations++;
      metrics.tar.objects += result.objects;
      metrics.tar.nativeSources += result.nativeSources;
      metrics.tar.fallbacks += Number(result.fallback);
    });
  for (const method of ['readTarBatches', 'readProgressiveTarBatches'])
    if (value?.[method])
      wrap(value, method, 'nativeTarProtocol', function (result) {
        metrics.tar.batches += result.batches;
      });
  if (
    value?.ScopeIndex ||
    value?.SourceRepository ||
    value?.MultipleComponentMerger ||
    value?.ModelComponentMerger ||
    value?.VersionHistory ||
    value?.LaneHistory ||
    value?.RemoteLanes ||
    ['SourceRepository', 'VersionHistory', 'LaneHistory'].includes(value?.default?.name) ||
    value?.ObjectFetcher ||
    value?.RustSourceValidator ||
    value?.RustObjectImporter ||
    value?.ObjectsWritable ||
    value?.importTarStream ||
    value?.readTarBatches ||
    value?.readProgressiveTarBatches
  ) {
    const file = Module._resolveFilename(request, parent);
    if (!metrics.modules[file])
      metrics.modules[file] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  return value;
};
process.on('exit', () => {
  if (output && process.pid === owner) fs.writeFileSync(output, JSON.stringify(metrics, null, 2));
});
