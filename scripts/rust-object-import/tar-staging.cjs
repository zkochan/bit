// Qualification-only owned staging. Ordinary imports do not use this boundary yet.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { transfer, replay } = require('./tar-stage-transfer.cjs');
const MAX_ARCHIVE = 2 * 1024 * 1024 * 1024;
const MAX_ACTIVE = 4;
const MAX_WAITING = 16;
let active = 0;
const waiting = [];
function aborted(signal) {
  return signal.reason instanceof Error ? signal.reason : new Error('tar staging aborted');
}
function acquire(signal) {
  if (signal.aborted) return Promise.reject(aborted(signal));
  if (active < MAX_ACTIVE) {
    active++;
    return Promise.resolve();
  }
  if (waiting.length >= MAX_WAITING) {
    const error = new Error('tar staging queue full');
    error.code = 'BIT_TAR_STAGE_QUEUE_FULL';
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, signal, cancel };
    function cancel() {
      waiting.splice(waiting.indexOf(entry), 1);
      reject(aborted(signal));
    }
    signal.addEventListener('abort', cancel, { once: true });
    waiting.push(entry);
  });
}
function release() {
  const next = waiting.shift();
  if (!next) {
    active--;
    return;
  }
  next.signal.removeEventListener('abort', next.cancel);
  next.resolve();
}
async function withStagedArchive(input, options, consume) {
  const maxBytes = options.maxBytes ?? MAX_ARCHIVE;
  const timeoutMs = options.timeoutMs ?? 120000;
  assert.ok(Number.isSafeInteger(maxBytes) && maxBytes >= 0 && maxBytes <= MAX_ARCHIVE);
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1);
  const root = options.directory ?? os.tmpdir();
  assert.ok(path.isAbsolute(root), 'staging directory must be absolute');
  const controller = new AbortController();
  const { signal } = controller;
  const admission = new AbortController();
  const abortAdmission = () => admission.abort(aborted(signal));
  signal.addEventListener('abort', abortAdmission, { once: true });
  const abort = () => controller.abort(options.signal.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new Error('tar staging timed out')), timeoutMs);
  let temporary,
    acquired = false,
    consumed = false,
    phase = 'queue',
    inputFailure,
    replayStream;
  const state = { bytes: 0, offset: 0, replayable: true };
  const inputError = (error) => {
    inputFailure = error;
    if (phase === 'queue') admission.abort(error);
    else if (phase === 'consume') controller.abort(error);
  };
  input.on('error', inputError);
  try {
    await acquire(admission.signal);
    acquired = true;
    phase = 'stage';
    signal.throwIfAborted();
    let ancestor = await fs.realpath(root);
    for (;;) {
      assert.ok(!syncFs.existsSync(path.join(ancestor, '.git')), 'staging must stay outside Git');
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    signal.throwIfAborted();
    temporary = await fs.mkdtemp(path.join(root, 'bit-tar-stage-'));
    state.archive = path.join(temporary, 'input.tar');
    await transfer(input, state, maxBytes, signal);
    if (inputFailure) throw inputFailure;
    signal.throwIfAborted();
    consumed = true;
    phase = 'consume';
    const result = await consume({ archive: state.archive, bytes: state.bytes, signal });
    signal.throwIfAborted();
    return result;
  } catch (error) {
    if (
      options.replay &&
      !consumed &&
      !signal.aborted &&
      state.replayable &&
      !(error instanceof assert.AssertionError)
    ) {
      if (!inputFailure && error.code === 'ERR_STREAM_PREMATURE_CLOSE') inputFailure = error;
      phase = 'replay';
      replayStream = replay(input, state, signal, () => inputFailure);
      const result = await options.replay(replayStream, { cause: error, signal });
      signal.throwIfAborted();
      assert.ok(
        replayStream.readableEnded && !replayStream.errored,
        'replay must consume the original stream to completion'
      );
      return result;
    }
    throw signal.aborted ? aborted(signal) : error;
  } finally {
    if (!input.destroyed) input.destroy();
    if (replayStream) {
      replayStream.destroy();
      await new Promise((resolve) => (replayStream.closed ? resolve() : replayStream.once('close', resolve)));
    }
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    signal.removeEventListener('abort', abortAdmission);
    try {
      if (temporary) await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
    } finally {
      if (acquired) release();
      input.removeListener('error', inputError);
    }
  }
}
module.exports = { withStagedArchive };
