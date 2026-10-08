import { execFile } from 'child_process';
import path from 'path';

const MAX_HASHES = 4096;
const MIN_HASHES = 1024;
let batchTail: Promise<unknown> = Promise.resolve();

export function nativeObjectHelperEnabled(count: number, minimum: number): boolean {
  const executable = process.env.BIT_RUST_OBJECT_IMPORT;
  return Boolean(executable && path.isAbsolute(executable) && process.platform !== 'win32' && count >= minimum);
}

/** Avoid mapping/allocating hashes on the default path and for batches below the crossover. */
export function nativeInventoryEnabled(count: number): boolean {
  return process.env.BIT_RUST_OBJECT_INVENTORY !== 'off' && nativeObjectHelperEnabled(count, MIN_HASHES);
}

/** Stateless filesystem checks only; pending objects and model caches are not filesystem existence. */
export async function nativeObjectExists(directory: string, hashes: string[]): Promise<boolean[] | undefined> {
  const executable = process.env.BIT_RUST_OBJECT_IMPORT;
  if (
    !executable ||
    !nativeInventoryEnabled(hashes.length) ||
    !path.isAbsolute(directory) ||
    !hashes.every((hash) => /^[a-f0-9]{40}$/.test(hash))
  ) {
    return undefined;
  }
  const result: boolean[] = [];
  for (let offset = 0; offset < hashes.length; offset += MAX_HASHES) {
    const batch = hashes.slice(offset, offset + MAX_HASHES);
    const values = await checkBatch(executable, directory, batch);
    if (!values) return undefined;
    result.push(...values);
  }
  return result;
}

async function checkBatch(executable: string, directory: string, hashes: string[]): Promise<boolean[] | undefined> {
  const buffer = await requestObjectBatch(executable, directory, hashes, 'BEX1', 65536);
  if (!buffer) return undefined;
  try {
    const response = JSON.parse(buffer.toString('utf8'));
    if (
      response.version !== 1 ||
      response.id !== 1 ||
      !Array.isArray(response.exists) ||
      response.exists.length !== hashes.length ||
      !response.exists.every((value: unknown) => typeof value === 'boolean')
    )
      return undefined;
    return response.exists;
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
  // Concurrent read-only operations share one bounded helper slot.
  const operation = batchTail.then(() => runBatch(executable, directory, hashes, magic, maxBuffer, frameSize));
  batchTail = operation.catch(() => undefined);
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
