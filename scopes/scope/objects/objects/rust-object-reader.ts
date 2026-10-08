import path from 'path';
import { resolveRustObjectImportExecutable } from './rust-object-discovery';
import { nativeObjectHelperEnabled, nativeReadOperationSize, requestObjectBatch } from './rust-object-inventory';

const MAX_RAW_BYTES = 256 * 1024;
export type NativeObjectHeader = { type: string; size: number; mtimeMs: number };

export function nativeReadsEnabled(count: number): boolean {
  return process.env.BIT_RUST_OBJECT_READS !== 'off' && nativeObjectHelperEnabled(count, 1024);
}

export function nativeHeadersEnabled(count: number): boolean {
  return process.env.BIT_RUST_OBJECT_HEADERS !== 'off' && nativeObjectHelperEnabled(count, 256);
}

function validHashes(directory: string, hashes: string[]): boolean {
  return path.isAbsolute(directory) && hashes.every((hash) => /^[a-f0-9]{40}$/.test(hash));
}

export async function nativeObjectHeaders(
  directory: string,
  hashes: string[]
): Promise<(NativeObjectHeader | undefined)[] | undefined> {
  if (!nativeHeadersEnabled(hashes.length) || !validHashes(directory, hashes)) return undefined;
  const executable = resolveRustObjectImportExecutable();
  if (!executable) return undefined;
  const results: (NativeObjectHeader | undefined)[] = [];
  const groupSize = nativeReadOperationSize();
  for (let offset = 0; offset < hashes.length; offset += groupSize) {
    const batch = hashes.slice(offset, offset + groupSize);
    const response = await requestObjectBatch(executable, directory, batch, 'BHD1', 8 * 1024 * 1024, 4096);
    if (!response) return undefined;
    const values = parseHeaders(response, batch.length);
    if (!values) return undefined;
    results.push(...values);
  }
  return results;
}

function parseHeaders(buffer: Buffer, count: number): (NativeObjectHeader | undefined)[] | undefined {
  try {
    const lines = buffer.toString('utf8').split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (lines.length !== Math.ceil(count / 4096)) return undefined;
    const results: (NativeObjectHeader | undefined)[] = [];
    for (let index = 0; index < lines.length; index++) {
      const response = JSON.parse(lines[index]);
      if (
        response.version !== 1 ||
        response.id !== index + 1 ||
        !Array.isArray(response.objects) ||
        response.objects.length !== Math.min(4096, count - index * 4096)
      )
        return undefined;
      for (const object of response.objects) {
        if (object === null) {
          results.push(undefined);
          continue;
        }
        const header = parseNativeObjectHeader(object);
        if (!header) return undefined;
        results.push(header);
      }
    }
    return results;
  } catch {
    return undefined;
  }
}

export function parseNativeObjectHeader(object: unknown): NativeObjectHeader | undefined {
  if (!object || typeof object !== 'object') return undefined;
  const { type, size, mtimeMs } = object as NativeObjectHeader;
  if (
    typeof type !== 'string' ||
    !type ||
    Buffer.byteLength(type) > 256 ||
    /[ \0]/.test(type) ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    !Number.isFinite(mtimeMs) ||
    mtimeMs < 0
  )
    return undefined;
  return { type, size, mtimeMs };
}

export async function nativeObjectBuffers(
  directory: string,
  hashes: string[]
): Promise<(Buffer | undefined)[] | undefined> {
  if (!nativeReadsEnabled(hashes.length) || !validHashes(directory, hashes)) return undefined;
  const executable = resolveRustObjectImportExecutable();
  if (!executable) return undefined;
  const results: (Buffer | undefined)[] = [];
  for (let offset = 0; offset < hashes.length; offset += 4096) {
    const batch = hashes.slice(offset, offset + 4096);
    const response = await requestObjectBatch(executable, directory, batch, 'BRD1', 32 * 1024 * 1024 + 131072, 128);
    if (!response) return undefined;
    const values = parseBuffers(response, batch.length);
    if (!values) return undefined;
    results.push(...values);
  }
  return results;
}

function parseBuffers(buffer: Buffer, count: number): (Buffer | undefined)[] | undefined {
  const results: (Buffer | undefined)[] = [];
  let offset = 0;
  for (let start = 0; start < count; start += 128) {
    const frameCount = Math.min(128, count - start);
    if (
      offset + 12 > buffer.length ||
      buffer.toString('ascii', offset, offset + 4) !== 'BRD1' ||
      buffer.readUInt32BE(offset + 4) !== start / 128 + 1 ||
      buffer.readUInt32BE(offset + 8) !== frameCount
    )
      return undefined;
    offset += 12;
    for (let index = 0; index < frameCount; index++) {
      if (offset >= buffer.length) return undefined;
      const status = buffer[offset++];
      if (status === 0) {
        results.push(undefined);
        continue;
      }
      if (status !== 1 || offset + 4 > buffer.length) return undefined;
      const length = buffer.readUInt32BE(offset);
      offset += 4;
      if (length > MAX_RAW_BYTES || offset + length > buffer.length) return undefined;
      results.push(buffer.subarray(offset, offset + length));
      offset += length;
    }
  }
  return offset === buffer.length ? results : undefined;
}
