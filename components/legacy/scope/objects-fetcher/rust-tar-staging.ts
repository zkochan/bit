import assert from 'assert';
import fs from 'fs/promises';
import syncFs from 'fs';
import os from 'os';
import path from 'path';
import { transfer, transferProgressively, replay } from './rust-tar-transfer';
import type { TarStageState, NativeSpool } from './rust-tar-transfer';
import type { TarProgressProducer } from './rust-tar-client';
import type { Readable } from 'stream';
const MAX_ARCHIVE = 2 * 1024 * 1024 * 1024;
const MAX_ACTIVE = 4;
const MAX_WAITING = 16;
let active = 0;
type Waiting = { resolve: () => void; reject: (error: Error) => void; signal: AbortSignal; cancel: () => void };
const waiting: Waiting[] = [];
export type TarStageOptions<T> = {
  maxBytes?: number;
  timeoutMs?: number;
  directory?: string;
  signal?: AbortSignal;
  spool?: (directory: string) => NativeSpool;
  progressive?: (stage: {
    archive: string;
    signal: AbortSignal;
    progress: TarProgressProducer;
    continuation: () => Readable;
  }) => Promise<T>;
  replay?: (input: Readable, context: { cause: unknown; signal: AbortSignal }) => Promise<T>;
};
function aborted(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : new Error('tar staging aborted');
}
function acquire(signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(aborted(signal));
  if (active < MAX_ACTIVE) {
    active++;
    return Promise.resolve();
  }
  if (waiting.length >= MAX_WAITING) {
    const error = Object.assign(new Error('tar staging queue full'), { code: 'BIT_TAR_STAGE_QUEUE_FULL' });
    return Promise.reject(error);
  }
  return new Promise<void>((resolve, reject) => {
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
export async function withStagedArchive<T>(
  input: Readable,
  options: TarStageOptions<T>,
  consume: (stage: { archive: string; bytes: number; signal: AbortSignal }) => Promise<T>
): Promise<T> {
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
  const abort = () => controller.abort(options.signal!.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new Error('tar staging timed out')), timeoutMs);
  let temporary: string | undefined,
    acquired = false,
    consumed = false,
    phase = 'queue',
    inputFailure: Error | undefined = input.errored ?? undefined,
    replayStream: Readable | undefined;
  const state: TarStageState = { bytes: 0, offset: 0, replayable: true };
  const inputError = (error: Error) => {
    inputFailure = error;
    state.failure = error;
    if (phase === 'queue') admission.abort(error);
    else if (phase === 'consume' && !options.progressive) controller.abort(error);
  };
  input.on('error', inputError);
  if (inputFailure) admission.abort(inputFailure);
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
    if (options.progressive) {
      await fs.writeFile(state.archive, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
      consumed = true;
      phase = 'consume';
      const result = await options.progressive({
        archive: state.archive,
        signal,
        progress: (producerSignal) =>
          transferProgressively(input, state, maxBytes, producerSignal, true, options.spool),
        continuation: () => {
          assert.ok(state.replayable, 'tar input cannot be replayed');
          if (!inputFailure && input.destroyed && !input.readableEnded)
            inputFailure = Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });
          phase = 'replay';
          replayStream = replay(input, state, signal, () => inputFailure);
          return replayStream;
        },
      });
      signal.throwIfAborted();
      if (replayStream)
        assert.ok(
          replayStream.readableEnded && !replayStream.errored,
          'replay must consume the original stream to completion'
        );
      return result;
    }
    await transfer(input, state, maxBytes, signal, options.spool);
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
      if (!inputFailure && error instanceof Error && 'code' in error && error.code === 'ERR_STREAM_PREMATURE_CLOSE')
        inputFailure = error;
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
      await new Promise<void>((resolve) => (replayStream!.closed ? resolve() : replayStream!.once('close', resolve)));
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
