const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { source } = require('./load-source.cjs');
const { withImportCancellation, cancelImportStream } = source(
  'components/legacy/scope/objects-fetcher/import-cancellation.ts'
);
test('cancellation preserves error identity and destroys a transport which resolves late', async () => {
  const controller = new AbortController();
  const reason = new Error('caller cancelled');
  let release;
  let discarded;
  const operation = withImportCancellation(
    new Promise((resolve) => {
      release = resolve;
    }),
    controller.signal,
    (stream) => {
      discarded = stream;
      stream.destroy();
    }
  );
  controller.abort(reason);
  await assert.rejects(operation, (error) => error === reason);
  const stream = new PassThrough();
  release(stream);
  await new Promise(setImmediate);
  assert.equal(discarded, stream);
  assert.ok(stream.destroyed);
});
test('completed operations detach cancellation and late failures are observed', async () => {
  const controller = new AbortController();
  assert.equal(await withImportCancellation(Promise.resolve(33), controller.signal), 33);
  controller.abort();
  let fail;
  const cancelled = new AbortController();
  cancelled.abort(new Error('stop'));
  await assert.rejects(
    withImportCancellation(
      new Promise((_, reject) => {
        fail = reject;
      }),
      cancelled.signal
    ),
    /stop/
  );
  fail(new Error('late transport failure'));
  await new Promise(setImmediate);
});
test('active stream cancellation and explicit detachment preserve original errors', async () => {
  const controller = new AbortController();
  const stream = new PassThrough();
  const reason = new Error('cancel');
  stream.on('error', () => undefined);
  const detach = cancelImportStream(stream, controller.signal);
  controller.abort(reason);
  assert.ok(stream.destroyed);
  assert.equal(stream.errored, reason);
  detach();
  const other = new AbortController();
  const kept = new PassThrough();
  cancelImportStream(kept, other.signal)();
  other.abort();
  assert.equal(kept.destroyed, false);
  kept.destroy();
});
