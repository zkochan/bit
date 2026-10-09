import { createReadStream } from 'fs';
import fs from 'fs/promises';
import { ObjectList } from '@teambit/objects';
import { logger } from '@teambit/legacy.logger';
import type { ObjectsWritable } from './objects-writable-stream';
import { readTarBatches, TarTimeoutError } from './rust-tar-client';
import type { TarDecision, TarOptions, TarRecord } from './rust-tar-client';

/** Remote framing/marker errors retain their origin for ObjectFetcher's error attribution. */
export class TarRemoteError extends Error {
  constructor(readonly original: unknown) {
    super(original instanceof Error ? original.message : String(original));
    this.name = 'TarRemoteError';
  }
}

/** Import an owned, immutable archive; callers retain it until this complete operation returns. */
export async function importStagedTar(
  executable: string,
  archive: string,
  writer: ObjectsWritable,
  options: TarOptions
) {
  let processed = 0;
  let nativeSources = 0;
  let policyFailure: unknown;
  let remoteFailure: unknown;
  let start: { schema?: string } | undefined;
  let end: unknown;
  const handle = await fs.open(archive, 'r');
  const load = async (file: TarRecord) => {
    const buffer = Buffer.alloc(file.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, file.offset + offset);
      if (!bytesRead) throw new Error('staged tar body changed before loading');
      offset += bytesRead;
    }
    return buffer;
  };
  try {
    let native;
    try {
      native = await readTarBatches(
        executable,
        archive,
        { ...options, awaitSelection: true },
        async (files, signal) => {
          const decisions: { offset: number; decision: TarDecision }[] = [];
          const selected: number[] = [];
          let error: unknown;
          let offset = 0;
          while (offset < files.length && !error) {
            const file = files[offset];
            if (['.BIT.START', '.BIT.END', '.BIT.ERROR'].includes(file.name)) {
              try {
                signal.throwIfAborted();
                if (file.name === '.BIT.ERROR') throw new Error(file.text!);
                if (file.name === '.BIT.START') {
                  start = JSON.parse(file.text!);
                  logger.debug('fromTarToObjectStream, start getting data', start);
                } else {
                  end = JSON.parse(file.text!);
                  logger.debug('fromTarToObjectStream, finished getting data', end);
                }
                offset++;
              } catch (cause) {
                error = cause;
                if (!signal.aborted || cause !== signal.reason) remoteFailure = cause;
              }
              continue;
            }
            let limit = offset;
            let refError: unknown;
            while (limit < files.length && !['.BIT.START', '.BIT.END', '.BIT.ERROR'].includes(files[limit].name)) {
              try {
                ObjectList.extractScopeAndHash(files[limit].name);
                limit++;
              } catch (cause) {
                refError = cause;
                break;
              }
            }
            if (limit === offset) {
              error = refError;
              remoteFailure = refError;
              break;
            }
            const first = offset;
            let decision;
            try {
              decision = await writer.prepareTarBatch(
                files.slice(first, limit).map((entry) => ({
                  name: entry.name,
                  sourceHash: entry.validation?.status === 'source' ? entry.validation.hash : undefined,
                })),
                (index) => load(files[first + index]),
                signal
              );
            } catch (cause) {
              policyFailure = cause;
              error = cause;
              break;
            }
            decisions.push({ offset: first, decision });
            selected.push(...decision.selected.map((index) => first + index));
            processed += decision.processed;
            error = decision.error;
            if (error && (!signal.aborted || error !== signal.reason)) policyFailure = error;
            if (!error && refError) {
              error = refError;
              remoteFailure = refError;
            }
            offset = limit;
          }
          return {
            selected,
            error,
            settle: async (persisted, repair) => {
              try {
                for (const entry of decisions) {
                  const local = persisted
                    ? new Set(
                        [...persisted]
                          .filter((index) => entry.decision.selected?.includes(index - entry.offset))
                          .map((index) => index - entry.offset)
                      )
                    : undefined;
                  await entry.decision.settle?.(local, repair);
                }
                nativeSources += persisted?.size ?? 0;
              } catch (cause) {
                policyFailure = cause;
                throw cause;
              }
            },
          };
        }
      );
    } catch (cause) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (cause instanceof TarTimeoutError) throw cause;
      if (policyFailure) throw policyFailure;
      if (remoteFailure) throw new TarRemoteError(remoteFailure);
      // The helper is reaped and all reserved Sources repaired before this continuation.
      // Decode from the original archive and skip completed objects, never completed policy.
      const input = createReadStream(archive);
      const objects = ObjectList.fromTarToObjectStream(input);
      const abort = () =>
        input.destroy(
          options.signal!.reason instanceof Error ? options.signal!.reason : new Error('tar import aborted')
        );
      options.signal?.addEventListener('abort', abort, { once: true });
      let seen = 0;
      try {
        for await (const item of objects) {
          options.signal?.throwIfAborted();
          if (seen++ < processed) continue;
          const name = item.scope ? `${item.scope}/${item.ref}` : item.ref.toString();
          const decision = await writer.prepareTarBatch([{ name }], async () => item.buffer, options.signal);
          try {
            await decision.settle(new Set());
            if (decision.error) throw decision.error;
          } catch (failure) {
            policyFailure = failure;
            throw failure;
          }
        }
      } catch (failure) {
        if (options.signal?.aborted) throw options.signal.reason;
        if (policyFailure) throw policyFailure;
        throw new TarRemoteError(failure);
      } finally {
        options.signal?.removeEventListener('abort', abort);
        objects.destroy();
        input.destroy();
      }
      if (seen < processed) throw new TarRemoteError(new Error('staged tar prefix changed before continuation'));
      return { objects: seen, nativeSources, fallback: true };
    }
    if (start?.schema === '1.0.0' && !end) {
      throw new TarRemoteError(
        new Error(`server terminated the stream unexpectedly (metadata: ${JSON.stringify(start)})`)
      );
    }
    return { objects: processed, nativeSources: native.persisted, fallback: false };
  } finally {
    await handle.close();
  }
}
