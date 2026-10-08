const { installed, source } = require('./load-source.cjs');
const { Repository, Source, Ref } = installed('@teambit/objects');
const { default: CurrentRepository } = source('scopes/scope/objects/objects/repository.ts');
const { ObjectsWritable } = source('components/legacy/scope/objects-fetcher/objects-writable-stream.ts');
const { WriteObjectsQueue } = source('components/legacy/scope/objects-fetcher/write-objects-queue.ts');
const { RustSourceValidator } = source('components/legacy/scope/objects-fetcher/rust-source-validator.ts');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
async function repository(directory) {
  const repo = await Repository.create({ scopePath: directory, scopeJson: { name: 'import-test' } });
  // Preserve the installed graph's class identities while testing the current writer method.
  repo.writeValidatedSourceToFS = CurrentRepository.prototype.writeValidatedSourceToFS;
  repo.getNativeSourceStoreOptions = CurrentRepository.prototype.getNativeSourceStoreOptions;
  return repo;
}
async function persist(repo, items, executable) {
  const queue = new WriteObjectsQueue();
  const validator = executable ? new RustSourceValidator(executable) : undefined;
  try {
    await pipeline(Readable.from(items), new ObjectsWritable(repo, 'test.remote', queue, {}, validator));
    await queue.onIdle();
    return { hashes: queue.addedHashes, stats: validator?.stats };
  } finally {
    validator?.dispose();
  }
}
async function item(contents) {
  const object = Source.from(contents);
  return { ref: object.hash(), buffer: await object.compress() };
}
module.exports = { repository, persist, item, Source, Ref };
