import { execFile } from 'child_process';
import path from 'path';
import { resolveRustObjectImportExecutable } from './rust-object-discovery';

const MAX_HASHES = 4096;

const MIN_HASHES = 1024;
let batchTail: Promise<void> = Promise.resolve();

export function nativeReadOperationSize(): number {
  return process.env.BIT_RUST_OBJECT_READ_OPERATIONS === 'off' ? MAX_HASHES : 16384;
}

export function nativeObjectHelperEnabled(count: number, minimum: number): boolean {
  return count >= minimum && process.platform !== 'win32' && Boolean(resolveRustObjectImportExecutable());
}

/** Avoid mapping/allocating hashes on the default path and for batches below the crossover. */
export function nativeInventoryEnabled(count: number): boolean {
  return process.env.BIT_RUST_OBJECT_INVENTORY !== 'off' && nativeObjectHelperEnabled(count, MIN_HASHES);
}

/** Stateless filesystem checks only; pending objects and model caches are not filesystem existence. */
export async function nativeObjectExists(directory: string, hashes: string[]): Promise<boolean[] | undefined> {
  const executable = resolveRustObjectImportExecutable();
  if (
    !executable ||
    !nativeInventoryEnabled(hashes.length) ||
    !path.isAbsolute(directory) ||
    !hashes.every((hash) => /^[a-f0-9]{40}$/.test(hash))
  ) {
    return undefined;
  }
  const result: boolean[] = [];
  const groupSize = nativeReadOperationSize();
  for (let offset = 0; offset < hashes.length; offset += groupSize) {
    const batch = hashes.slice(offset, offset + groupSize);
    const values = await checkBatch(executable, directory, batch);
    if (!values) return undefined;
    result.push(...values);
  }
  return result;
}

async function checkBatch(executable: string, directory: string, hashes: string[]): Promise<boolean[] | undefined> {
  const buffer = await requestObjectBatch(executable, directory, hashes, 'BEX1', hashes.length * 6 + 1024, MAX_HASHES);
  if (!buffer) return undefined;
  try {
    const lines = buffer.toString('utf8').split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (lines.length !== Math.ceil(hashes.length / MAX_HASHES)) return undefined;
    const values: boolean[] = [];
    for (let index = 0; index < lines.length; index++) {
      const response = JSON.parse(lines[index]);
      if (
        response.version !== 1 ||
        response.id !== index + 1 ||
        !Array.isArray(response.exists) ||
        response.exists.length !== Math.min(MAX_HASHES, hashes.length - index * MAX_HASHES) ||
        !response.exists.every((value: unknown) => typeof value === 'boolean')
      )
        return undefined;
      values.push(...response.exists);
    }
    return values;
  } catch {
    return undefined;
  }
}

export function requestObjectBatch(
  executable: string,
  directory: string,
  hashes: string[],
  magic: string,
  maxBuffer: number,
  frameSize = hashes.length
): Promise<Buffer | undefined> {
  return withObjectHelperSlot(() => runBatch(executable, directory, hashes, magic, maxBuffer, frameSize));
}

export function withObjectHelperSlot<T>(run: () => Promise<T | undefined>): Promise<T | undefined> {
  // Concurrent read-only operations share one bounded helper slot.
  const operation = batchTail.then(run);
  batchTail = operation.then(
    () => undefined,
    () => undefined
  );
  return operation.catch(() => undefined);
}

function runBatch(
  executable: string,
  directory: string,
  hashes: string[],
  magic: string,
  maxBuffer: number,
  frameSize: number
): Promise<Buffer | undefined> {
  const frames: Buffer[] = [];
  for (let offset = 0; offset < hashes.length; offset += frameSize) {
    const batch = hashes.slice(offset, offset + frameSize);
    const frame = Buffer.alloc(12 + batch.length * 20);
    frame.write(magic);
    frame.writeUInt32BE(offset / frameSize + 1, 4);
    frame.writeUInt32BE(batch.length, 8);
    batch.forEach((hash, index) => Buffer.from(hash, 'hex').copy(frame, 12 + index * 20));
    frames.push(frame);
  }
  const frame = Buffer.concat(frames);
  return new Promise((resolve) => {
    const child = execFile(
      executable,
      ['--objects-dir', directory],
      { timeout: 30000, maxBuffer, encoding: 'buffer' },
      (error, stdout) => resolve(error ? undefined : stdout)
    );
    // An old/crashing helper can close stdin before accepting the frame.
    child.stdin?.on('error', () => {});
    child.stdin?.end(frame);
  });
}
