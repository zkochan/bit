import { execFile } from 'child_process';
import path from 'path';

const MAX_HASHES = 4096;
const MIN_HASHES = 1024;

/** Stateless filesystem checks only; pending objects and model caches are not filesystem existence. */
export async function nativeObjectExists(directory: string, hashes: string[]): Promise<boolean[] | undefined> {
  const executable = process.env.BIT_RUST_OBJECT_IMPORT;
  if (
    !executable ||
    !path.isAbsolute(executable) ||
    !path.isAbsolute(directory) ||
    process.env.BIT_RUST_OBJECT_INVENTORY === 'off' ||
    process.platform === 'win32' ||
    hashes.length < MIN_HASHES ||
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

function checkBatch(executable: string, directory: string, hashes: string[]): Promise<boolean[] | undefined> {
  const frame = Buffer.alloc(12 + hashes.length * 20);
  frame.write('BEX1');
  frame.writeUInt32BE(1, 4);
  frame.writeUInt32BE(hashes.length, 8);
  hashes.forEach((hash, index) => Buffer.from(hash, 'hex').copy(frame, 12 + index * 20));
  return new Promise((resolve) => {
    const child = execFile(
      executable,
      ['--objects-dir', directory],
      { timeout: 30000, maxBuffer: 65536, encoding: 'utf8' },
      (error, stdout) => {
        if (error) return resolve(undefined);
        try {
          const response = JSON.parse(stdout);
          if (
            response.version !== 1 ||
            response.id !== 1 ||
            !Array.isArray(response.exists) ||
            response.exists.length !== hashes.length ||
            !response.exists.every((value: unknown) => typeof value === 'boolean')
          ) {
            return resolve(undefined);
          }
          resolve(response.exists);
        } catch {
          resolve(undefined);
        }
      }
    );
    // An old/crashing helper can close stdin before accepting the frame.
    child.stdin?.on('error', () => {});
    child.stdin?.end(frame);
  });
}
