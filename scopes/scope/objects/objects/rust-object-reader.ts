import path from 'path';
import { nativeObjectHelperEnabled, requestObjectBatch } from './rust-object-inventory';

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
  const executable = process.env.BIT_RUST_OBJECT_IMPORT!;
  const results: (NativeObjectHeader | undefined)[] = [];
  for (let offset = 0; offset < hashes.length; offset += 4096) {
    const batch = hashes.slice(offset, offset + 4096);
    const response = await requestObjectBatch(executable, directory, batch, 'BHD1', 8 * 1024 * 1024);
    if (!response) return undefined;
    const values = parseHeaders(response, batch.length);
    if (!values) return undefined;
    results.push(...values);
  }
  return results;
}

function parseHeaders(buffer: Buffer, count: number): (NativeObjectHeader | undefined)[] | undefined {
  try {
    const response = JSON.parse(buffer.toString('utf8'));
    if (
      response.version !== 1 ||
      response.id !== 1 ||
      !Array.isArray(response.objects) ||
      response.objects.length !== count
    )
      return undefined;
    const results: (NativeObjectHeader | undefined)[] = [];
    for (const object of response.objects) {
      if (object === null) {
        results.push(undefined);
        continue;
      }
      if (
        !object ||
        typeof object.type !== 'string' ||
        !object.type ||
        Buffer.byteLength(object.type) > 256 ||
        /[ \0]/.test(object.type) ||
        !Number.isSafeInteger(object.size) ||
        object.size < 0 ||
        !Number.isFinite(object.mtimeMs) ||
        object.mtimeMs < 0
      )
        return undefined;
      results.push({ type: object.type, size: object.size, mtimeMs: object.mtimeMs });
    }
    return results;
  } catch {
    return undefined;
  }
}

export async function nativeObjectBuffers(
  directory: string,
  hashes: string[]
): Promise<(Buffer | undefined)[] | undefined> {
  if (!nativeReadsEnabled(hashes.length) || !validHashes(directory, hashes)) return undefined;
  const executable = process.env.BIT_RUST_OBJECT_IMPORT!;
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
