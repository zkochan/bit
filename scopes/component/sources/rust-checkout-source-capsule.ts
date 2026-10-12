import fs from 'fs-extra';
import { createHash } from 'crypto';
import {
  canUseRustHistoryQueryRepository,
  canHydrateRustHistoryQuerySources,
  hasRustSnapshotFunctions,
  hasRustSnapshotFunctionReference,
} from '@teambit/objects';
import type { Repository, Ref, Source } from '@teambit/objects';
import type { MaterializationSession } from './rust-workspace-materializer';

export type CheckoutSourceCapsule = object;
const capsuleData = new WeakMap<CheckoutSourceCapsule, { hash: string; body: Buffer; compressed: Buffer }>();
const sourceModule = require('@teambit/objects/dist/models/source.js');
const readFile = fs.readFileSync;
const equals = Buffer.prototype.equals;
const hash = createHash;

export function canUseRustCheckoutCapsules(repository: Repository): boolean {
  return (
    Object.getPrototypeOf(String.prototype) === Object.prototype &&
    !Object.getOwnPropertyDescriptor(String.prototype, Symbol.split) &&
    !Object.getOwnPropertyDescriptor(Object.prototype, Symbol.split) &&
    canUseRustHistoryQueryRepository(repository) &&
    canHydrateRustHistoryQuerySources() &&
    hasRustSnapshotFunctions([
      'CheckoutSyncObjectParser',
      'CheckoutSyncInflation',
      'CheckoutSyncBufferParsing',
      'CheckoutSyncBufferStatics',
      'CheckoutSyncHeaderParsing',
      'CheckoutSyncHeaderConstants',
      'CheckoutSyncSourceFS',
      'CheckoutSyncSourceFSPrimitives',
    ])
  );
}

/** Keep live disk precedence: only byte-identical compressed input may reuse the verified inflation. */
export function loadRustCheckoutCapsule(
  repository: Repository,
  reference: Ref,
  capsule: CheckoutSourceCapsule
): Source | undefined {
  const saved = capsuleData.get(capsule);
  if (!saved || saved.hash !== reference.hash || !canUseRustCheckoutCapsules(repository)) return undefined;
  const constructor = Object.getOwnPropertyDescriptor(sourceModule, 'default')?.value;
  if (!hasRustSnapshotFunctionReference('HistoryQuerySourceClass', constructor)) return undefined;
  try {
    const current = readFile(repository.objectPath(reference));
    if (!equals.call(current, saved.compressed)) return undefined;
    const source = constructor.parse(saved.body, reference.hash);
    capsuleData.delete(capsule);
    return source;
  } catch {
    // The public load reproduces its own exception and observes changed hooks or bytes.
    return undefined;
  }
}

/** Validate the entire raw response before any capsule can escape to a lazy Source getter. */
export async function readRustCheckoutCapsules(
  session: MaterializationSession,
  hashes: string[],
  frame: (id: number) => Buffer
): Promise<Array<CheckoutSourceCapsule | undefined> | undefined> {
  let result: Array<CheckoutSourceCapsule | undefined> | undefined;
  await session.request(
    frame,
    hashes.length,
    (response, body) => {
      if (response.failed) return true;
      if (!hasRustSnapshotFunctions(['CheckoutSyncBufferParsing', 'CheckoutSyncBufferStatics'])) return false;
      const rows = (response.data as { files?: unknown } | undefined)?.files;
      if (!body || !Array.isArray(rows) || rows.length !== hashes.length || response.completed !== hashes.length)
        return false;
      let offset = 0;
      const capsules: Array<CheckoutSourceCapsule | undefined> = [];
      for (const [index, row] of rows.entries()) {
        if (!row || row.hash !== hashes[index]) return false;
        if (row.cached === true) {
          capsules.push(undefined);
          continue;
        }
        if (
          row.offset !== offset ||
          !Number.isSafeInteger(row.bodySize) ||
          row.bodySize < 0 ||
          !Number.isSafeInteger(row.compressedSize) ||
          row.compressedSize <= 0
        )
          return false;
        const end = offset + row.bodySize + row.compressedSize;
        if (!Number.isSafeInteger(end) || end > body.length || end > 8 * 1024 * 1024) return false;
        const contents = Buffer.from(body.subarray(offset, offset + row.bodySize));
        if (hash('sha1').update(contents).digest('hex') !== row.hash) return false;
        const capsule = {};
        capsuleData.set(capsule, {
          hash: row.hash,
          body: contents,
          compressed: Buffer.from(body.subarray(offset + row.bodySize, end)),
        });
        capsules.push(capsule);
        offset = end;
      }
      if (offset !== body.length) return false;
      result = capsules;
      return true;
    },
    32 * 1024 * 1024,
    false,
    true
  );
  return result;
}
