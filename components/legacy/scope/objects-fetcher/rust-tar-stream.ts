import type { Readable } from 'stream';
import type { ObjectsWritable } from './objects-writable-stream';
import type { TarOptions } from './rust-tar-client';
import { importCanonicalTar, importStagedTar } from './rust-tar-importer';
import { withStagedArchive } from './rust-tar-staging';

/** Stage once; pre-policy failures replay original bytes, later failures continue by object cursor. */
export async function importTarStream(
  input: Readable,
  executable: string,
  writer: ObjectsWritable,
  options: TarOptions
) {
  return withStagedArchive(
    input,
    {
      signal: options.signal,
      replay: async (original, { signal }) => ({
        objects: await importCanonicalTar(original, writer, signal),
        nativeSources: 0,
        fallback: true,
      }),
    },
    ({ archive, signal }) => importStagedTar(executable, archive, writer, { ...options, signal })
  );
}
