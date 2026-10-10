import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';

export type TarStageState = {
  archive?: string;
  bytes: number;
  offset: number;
  replayable: boolean;
  pending?: Uint8Array;
  failure?: Error;
};
export type NativeSpool = {
  appendArchive(offset: number, buffer: Buffer, maxBytes: number): Promise<number | undefined>;
  disposeAndWait(): Promise<void>;
};

function aborted(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : new Error('tar staging aborted');
}
/** Wait without owning/destroying the transport, so helper failure can replay unread input. */
async function nextChunk(input: Readable, signal: AbortSignal, state: TarStageState): Promise<Uint8Array | null> {
  for (;;) {
    signal.throwIfAborted();
    if (state.failure) throw state.failure;
    const chunk = input.read();
    if (chunk !== null) return chunk;
    if (input.errored) throw input.errored;
    if (input.readableEnded) return null;
    if (input.destroyed) throw Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(aborted(signal));
      };
      function cleanup() {
        for (const event of ['readable', 'end', 'error', 'close']) input.removeListener(event, ready);
        signal.removeEventListener('abort', abort);
      }
      for (const event of ['readable', 'end', 'error', 'close']) input.once(event, ready);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}
export async function transfer(
  input: Readable,
  state: TarStageState,
  maxBytes: number,
  signal: AbortSignal,
  spool?: (directory: string) => NativeSpool
) {
  for await (const _update of transferProgressively(input, state, maxBytes, signal, false, spool)) {
    // Complete-transfer callers deliberately wait for EOF.
  }
}
export async function* transferProgressively(
  input: Readable,
  state: TarStageState,
  maxBytes: number,
  signal: AbortSignal,
  existing = false,
  spool?: (directory: string) => NativeSpool
) {
  const handle = await fs.promises.open(state.archive!, existing ? 'r+' : 'wx', 0o600);
  let native: NativeSpool | undefined;
  let active: NativeSpool | undefined;
  const abort = () => {
    void native?.disposeAndWait();
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    native = spool?.(path.dirname(state.archive!));
    active = native;
    for (;;) {
      const chunk = await nextChunk(input, signal, state);
      if (chunk === null) return;
      if (!(chunk instanceof Uint8Array)) {
        state.replayable = false;
        throw new TypeError('tar staging requires byte chunks');
      }
      state.pending = chunk;
      state.offset = 0;
      if (state.bytes + state.pending.byteLength > maxBytes) {
        throw Object.assign(new Error('staged archive byte limit exceeded'), { code: 'BIT_TAR_STAGE_LIMIT' });
      }
      while (state.offset < state.pending.byteLength) {
        signal.throwIfAborted();
        const remaining = state.pending.byteLength - state.offset;
        if (active) {
          const count = Math.min(remaining, 1024 * 1024);
          const pending = Buffer.from(state.pending.buffer, state.pending.byteOffset + state.offset, count);
          const acknowledged = await active.appendArchive(state.bytes, pending, maxBytes);
          signal.throwIfAborted();
          if (acknowledged !== undefined) {
            state.offset += count;
            state.bytes = acknowledged;
            continue;
          }
          // Reaped helper may have written an unacknowledged prefix. Verify it before continuing.
          const stat = await handle.stat();
          const written = stat.size - state.bytes;
          if (written < 0 || written > count) state.replayable = false;
          assert.ok(written >= 0 && written <= count, 'native spool changed the staged prefix');
          if (written) {
            const found = Buffer.alloc(written);
            const read = await fs.promises.open(state.archive!, 'r');
            let bytesRead: number;
            try {
              ({ bytesRead } = await read.read(found, 0, written, state.bytes));
            } finally {
              await read.close();
            }
            const valid = bytesRead === written && found.equals(pending.subarray(0, written));
            if (!valid) state.replayable = false;
            assert.ok(valid, 'native spool changed pending bytes');
            state.offset += written;
            state.bytes += written;
          }
          active = undefined;
          continue;
        }
        const { bytesWritten } = await handle.write(state.pending, state.offset, remaining, state.bytes);
        assert.ok(bytesWritten > 0 && bytesWritten <= remaining, 'invalid staging write progress');
        state.offset += bytesWritten;
        state.bytes += bytesWritten;
      }
      state.pending = undefined;
      yield { bytes: state.bytes };
    }
  } finally {
    signal.removeEventListener('abort', abort);
    await native?.disposeAndWait();
    await handle.close();
  }
}
export function replay(
  input: Readable,
  state: TarStageState,
  signal: AbortSignal,
  inputFailure: () => Error | undefined
) {
  async function* bytes() {
    signal.throwIfAborted();
    if (state.bytes) {
      let count = 0;
      for await (const chunk of fs.createReadStream(state.archive!, { end: state.bytes - 1 })) {
        count += chunk.length;
        yield chunk;
      }
      assert.equal(count, state.bytes, 'staging prefix changed before replay');
    }
    if (state.pending) yield state.pending.subarray(state.offset);
    if (input.destroyed || inputFailure()) {
      let buffered;
      while ((buffered = input.read()) !== null) yield buffered;
    }
    if (inputFailure()) throw inputFailure();
    for await (const chunk of input) yield chunk;
  }
  const stream = Readable.from(bytes(), { objectMode: false });
  const abort = () => {
    input.destroy(aborted(signal));
    stream.destroy(aborted(signal));
  };
  signal.addEventListener('abort', abort, { once: true });
  stream.once('close', () => signal.removeEventListener('abort', abort));
  if (signal.aborted) abort();
  return stream;
}
