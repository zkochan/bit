import assert from 'assert';
import fs from 'fs';
import { Readable } from 'stream';

export type TarStageState = {
  archive?: string;
  bytes: number;
  offset: number;
  replayable: boolean;
  pending?: Uint8Array;
};

function aborted(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : new Error('tar staging aborted');
}
export async function transfer(input: Readable, state: TarStageState, maxBytes: number, signal: AbortSignal) {
  const handle = await fs.promises.open(state.archive!, 'wx', 0o600);
  const iterator = input.iterator({ destroyOnReturn: false });
  const abort = () => input.destroy(aborted(signal));
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const item = await iterator.next();
      if (item.done) return;
      if (!(item.value instanceof Uint8Array)) {
        state.replayable = false;
        throw new TypeError('tar staging requires byte chunks');
      }
      state.pending = item.value;
      state.offset = 0;
      if (state.bytes + state.pending.byteLength > maxBytes) {
        const error = Object.assign(new Error('staged archive byte limit exceeded'), { code: 'BIT_TAR_STAGE_LIMIT' });
        throw error;
      }
      while (state.offset < state.pending.byteLength) {
        signal.throwIfAborted();
        const remaining = state.pending.byteLength - state.offset;
        const { bytesWritten } = await handle.write(state.pending, state.offset, remaining, state.bytes);
        assert.ok(bytesWritten > 0 && bytesWritten <= remaining, 'invalid staging write progress');
        state.offset += bytesWritten;
        state.bytes += bytesWritten;
      }
      state.pending = undefined;
    }
  } finally {
    signal.removeEventListener('abort', abort);
    try {
      await iterator.return?.();
    } finally {
      await handle.close();
    }
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
    if (input.destroyed) {
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
