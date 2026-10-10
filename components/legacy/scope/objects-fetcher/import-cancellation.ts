import type { Readable } from 'stream';

/** Await a transport without leaking a late stream when cancellation wins the race. */
export function withImportCancellation<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  discard?: (value: T) => void
): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    let cancelled = false;
    const abort = () => {
      cancelled = true;
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        if (cancelled) discard?.(value);
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        if (!cancelled) reject(error);
      }
    );
  });
}
export function cancelImportStream(stream: Readable, signal?: AbortSignal): () => void {
  if (!signal) return () => undefined;
  const abort = () =>
    stream.destroy(signal.reason instanceof Error ? signal.reason : new Error('object import aborted'));
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  return () => signal.removeEventListener('abort', abort);
}
