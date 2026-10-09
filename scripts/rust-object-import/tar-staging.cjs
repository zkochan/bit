// Qualification-only owned staging. Ordinary imports do not use this boundary yet.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
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
  if (waiting.length >= MAX_WAITING) return Promise.reject(new Error('tar staging queue full'));
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
  const abort = () => controller.abort(options.signal.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new Error('tar staging timed out')), timeoutMs);
  let temporary,
    acquired = false;
  const inputError = (error) => {
    controller.abort(error);
  };
  input.on('error', inputError);
  try {
    await acquire(signal);
    acquired = true;
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
    const archive = path.join(temporary, 'input.tar');
    let bytes = 0;
    const bounded = new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        callback(bytes > maxBytes ? new Error('staged archive byte limit exceeded') : null, chunk);
      },
    });
    await pipeline(input, bounded, syncFs.createWriteStream(archive, { flags: 'wx', mode: 0o600 }), { signal });
    signal.throwIfAborted();
    const result = await consume({ archive, bytes, signal });
    signal.throwIfAborted();
    return result;
  } catch (error) {
    if (!input.destroyed) input.destroy();
    throw signal.aborted ? aborted(signal) : error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    try {
      if (temporary) await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
    } finally {
      if (acquired) release();
      input.removeListener('error', inputError);
    }
  }
}
module.exports = { withStagedArchive };
