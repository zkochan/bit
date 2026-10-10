import { Writable } from 'stream';
import { logger } from '@teambit/legacy.logger';
import { deflate } from '@teambit/legacy.utils';
import type { ObjectItem, Repository } from '@teambit/objects';
import {
  BitObject,
  Lane,
  LaneHistory,
  ModelComponent,
  ObjectList,
  Version,
  VersionHistory,
  nativeIndices,
  nativeSelections,
} from '@teambit/objects';
import type { WriteObjectsQueue } from './write-objects-queue';
import type { ComponentsPerRemote } from '../component-ops/multiple-component-merger';
import type { RustObjectImporter, MetadataValidation } from './rust-object-importer';
import type { RustSourceValidator, SourceValidation } from './rust-source-validator';

export type TarImportDescriptor = { name: string; sourceHash?: string; metadata?: MetadataValidation };

const TIMEOUT_MINUTES_WARNING = 3;
const TIMEOUT_MINUTES_EXIT = 30;
const MAX_NATIVE_MUTABLE_BYTES = 16 * 1024;

/**
 * first, write all immutable objects, such as files/sources/versions into the filesystem, as they arrive.
 * even if the process will crush later and the component-object won't be written, there is no
 * harm of writing these objects.
 * then, merge the component objects and write them to the filesystem. the index.json is written
 * as well to make sure they're indexed immediately, even if the process crushes on the next remote.
 * finally, take care of the lanes. the remote-lanes are not written at this point, only once all
 * remotes are processed. see @writeManyObjectListToModel.
 */
export class ObjectsWritable extends Writable {
  private timeoutId: NodeJS.Timeout;
  private intervalCounter = 0;
  private sequentialMetadata?: { object: Version; buffer: Buffer; ref: ReturnType<Version['hash']> }[];
  constructor(
    private repo: Repository,
    private remoteName: string,
    private objectsQueue: WriteObjectsQueue,
    private componentsPerRemote: ComponentsPerRemote,
    private sourceValidator?: RustSourceValidator,
    private nativeImporter?: RustObjectImporter,
    private mutableWriter?: RustObjectImporter
  ) {
    super({ objectMode: true });
    if (!this.componentsPerRemote[remoteName]) this.componentsPerRemote[remoteName] = [];
    this.timeoutId = setInterval(
      () => {
        this.intervalCounter += 1;
        const timeLapsedInMinutes = this.intervalCounter * TIMEOUT_MINUTES_WARNING;
        const msg = `fetching from ${remoteName} takes more than ${timeLapsedInMinutes} minutes. make sure the remote is responsive`;
        logger.warn(msg);
        logger.console(`\n${msg}`, 'warn', 'yellow');
        if (timeLapsedInMinutes > TIMEOUT_MINUTES_EXIT) {
          throw new Error(`fetching from ${remoteName} takes more than ${TIMEOUT_MINUTES_EXIT} minutes. exiting...`);
        }
      },
      TIMEOUT_MINUTES_WARNING * 60 * 1000
    );
  }
  async _write(obj: ObjectItem, _, callback: Function) {
    logger.trace('ObjectsWritable.write', obj.ref);
    if (!obj.ref || !obj.buffer) {
      return callback(new Error('objectItem expected to have "ref" and "buffer" props'));
    }
    try {
      if (this.nativeImporter) await this.writeNativeBatch([obj]);
      else await this.writeObjectToFs(obj);
      return callback();
    } catch (err: any) {
      logger.error(`found an issue during write of ${obj.ref.toString()}`, err);
      return callback(err);
    }
  }

  async _writev(chunks: { chunk: ObjectItem }[], callback: (error?: Error) => void) {
    try {
      // Validate buffered input together, but retain the existing ordered parse/write/merge behavior.
      for (let offset = 0; offset < chunks.length; offset += 16) {
        const objects = chunks.slice(offset, offset + 16).map(({ chunk }) => chunk);
        for (const object of objects) {
          if (!object.ref || !object.buffer) throw new Error('objectItem expected to have "ref" and "buffer" props');
        }
        if (this.nativeImporter) {
          await this.writeNativeBatch(objects);
          continue;
        }
        const validator = this.sourceValidator;
        const validations = validator
          ? await Promise.all(objects.map((object) => validator.validate(object.ref.toString(), object.buffer)))
          : undefined;
        for (let index = 0; index < objects.length; index += 1) {
          await this.writeObjectToFs(objects[index], validations ? { result: validations[index] } : undefined);
        }
      }
      callback();
    } catch (error: any) {
      logger.error(`found an issue during buffered write from ${this.remoteName}`, error);
      callback(error);
    }
  }

  private async writeNativeBatch(objects: ObjectItem[]) {
    let legacyError: unknown;
    const importer = this.nativeImporter;
    if (!importer) throw new Error('native importer unavailable');
    await importer.importBatch(
      objects,
      async (values) => {
        const selected: number[] = [];
        this.beginSequentialMetadata();
        for (let index = 0; index < objects.length; index += 1) {
          try {
            const value = values[index];
            if (value && !('metadata' in value)) {
              await this.flushSequentialMetadata();
              if (this.objectsQueue.reserveNativeSource(objects[index].ref.toString())) selected.push(index);
            } else {
              await this.writeObjectToFs(
                objects[index],
                { result: undefined },
                value && 'metadata' in value ? value : undefined
              );
            }
          } catch (error) {
            legacyError = error;
            break;
          }
        }
        try {
          await this.flushSequentialMetadata();
        } catch (error) {
          legacyError = error;
        }
        this.sequentialMetadata = undefined;
        return selected;
      },
      async (selected, persisted) => {
        for (const index of selected) {
          const object = objects[index];
          if (persisted?.has(index)) this.repo.removeFromCache(object.ref);
          else {
            const { object: parsed, inflatedSize } = await BitObject.parseObjectWithSize(object.buffer);
            await this.repo.writeObjectsToTheFS(
              [parsed],
              new Map([[parsed, { buffer: object.buffer, inflatedSize, ref: object.ref }]])
            );
          }
        }
      }
    );
    if (legacyError) throw legacyError;
  }

  /** Prepare one transport-validated tar batch; the transport owns markers and helper lifetime. */
  async prepareTarBatch(
    entries: TarImportDescriptor[],
    load: (index: number) => Promise<Buffer>,
    signal?: AbortSignal
  ) {
    if (entries.length > 16) throw new Error('tar batch exceeds 16 entries');
    const reserved = new Map<number, ReturnType<typeof ObjectList.extractScopeAndHash>>();
    let error: unknown;
    let processed = 0;
    const initialEligibility = this.nativeStoreEligibility();
    const native = typeof initialEligibility === 'boolean' ? initialEligibility : await initialEligibility;
    this.beginSequentialMetadata();
    for (let index = 0; index < entries.length; index += 1) {
      try {
        signal?.throwIfAborted();
        const entry = entries[index];
        if (['.BIT.START', '.BIT.END', '.BIT.ERROR'].includes(entry.name)) {
          throw new Error('tar markers must be processed by the transport');
        }
        const object = ObjectList.extractScopeAndHash(entry.name);
        if (native && entry.sourceHash === object.ref.toString() && /^[a-f0-9]{40}$/.test(entry.sourceHash)) {
          await this.flushSequentialMetadata();
          if (this.objectsQueue.reserveNativeSource(entry.sourceHash)) reserved.set(index, object);
        } else {
          // Hydrate through the canonical parser, rechecking eligibility after earlier policy.
          const eligibility = entry.metadata ? this.nativeStoreEligibility() : false;
          const metadata = (typeof eligibility === 'boolean' ? eligibility : await eligibility)
            ? entry.metadata
            : undefined;
          const buffer = metadata ? Buffer.alloc(0) : await load(index);
          signal?.throwIfAborted();
          await this.writeObjectToFs({ ...object, buffer }, { result: undefined }, metadata);
        }
        processed += 1;
      } catch (cause) {
        error = cause;
        break;
      }
    }
    try {
      await this.flushSequentialMetadata();
    } catch (cause) {
      error = cause;
    }
    this.sequentialMetadata = undefined;
    // Metadata policy may change hooks or methods. Downgrade reserved Sources before native commit.
    let selected: number[] = [];
    try {
      if (!signal?.aborted) {
        const eligibility = this.nativeStoreEligibility();
        if (typeof eligibility === 'boolean' ? eligibility : await eligibility) selected = [...reserved.keys()];
      }
    } catch (cause) {
      error ??= cause;
    }
    let settled = false;
    return {
      selected,
      error,
      processed,
      settle: async (persisted?: ReadonlySet<number>, repair = true) => {
        if (settled) throw new Error('tar batch already settled');
        settled = true;
        // Invalidate all possibly written Sources even if an earlier repair subsequently fails.
        for (const { ref } of reserved.values()) this.repo.removeFromCache(ref);
        if (persisted && [...persisted].some((index) => !selected.includes(index))) {
          throw new Error('invalid tar Source acknowledgement');
        }
        if (!repair) return;
        for (const [index, object] of reserved) {
          if (persisted?.has(index)) continue;
          const buffer = await load(index);
          const { object: parsed, inflatedSize } = await BitObject.parseObjectWithSize(buffer);
          if (parsed.getType() !== 'Source' || parsed.hash().toString() !== object.ref.toString()) {
            throw new Error('staged tar Source changed before repair');
          }
          await this.repo.writeObjectsToTheFS([parsed], new Map([[parsed, { buffer, inflatedSize, ref: object.ref }]]));
        }
      },
    };
  }

  async _final(callback) {
    clearInterval(this.timeoutId);
    callback();
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    clearInterval(this.timeoutId);
    callback(error);
  }

  private async writeObjectToFs(
    obj: ObjectItem,
    validation?: { result?: SourceValidation },
    metadata?: MetadataValidation
  ) {
    if (this.sourceValidator) {
      const validated = validation
        ? validation.result
        : await this.sourceValidator.validate(obj.ref.toString(), obj.buffer);
      if (validated) {
        await this.flushSequentialMetadata();
        await this.objectsQueue.addImmutableObject(obj.ref.toString(), () =>
          this.repo.writeValidatedSourceToFS(obj.ref, obj.buffer)
        );
        return;
      }
      logger.debug(`Rust Source import fallback: ${this.sourceValidator.unavailableReason || 'legacy object'}`);
    }
    if (!metadata || !metadata.metadata.startsWith('Version ')) await this.flushSequentialMetadata();
    const { object: bitObject, inflatedSize } = metadata
      ? BitObject.parseInflatedObjectWithSize(Buffer.from(metadata.metadata, 'utf8'))
      : await BitObject.parseObjectWithSize(obj.buffer);
    // Batching/control comparison: retain the existing hydration/cache behavior but avoid redundant compression.
    if (
      process.env.BIT_RUST_OBJECT_IMPORT === 'control' &&
      bitObject.getType() === 'Source' &&
      bitObject.hash().isEqual(obj.ref)
    ) {
      const raw = new Map([[bitObject, { buffer: obj.buffer, inflatedSize, ref: obj.ref }]]);
      await this.objectsQueue.addImmutableObject(obj.ref.toString(), () =>
        this.repo.writeObjectsToTheFS([bitObject], raw)
      );
      return;
    }
    if (bitObject instanceof Lane) {
      throw new Error('ObjectsWritable does not support lanes');
    }
    if (bitObject instanceof ModelComponent) {
      this.addComponentToComponentsPerRemote(bitObject);
    } else if (bitObject instanceof VersionHistory) {
      // technically it's mutable, but it's ok to have it in the same queue with high concurrency because the merge is
      // simple enough and can't interrupt others
      await this.objectsQueue.addImmutableObject(obj.ref.toString(), () => this.mergeVersionHistory(bitObject));
    } else if (bitObject instanceof LaneHistory) {
      // technically it's mutable, but it's ok to have it in the same queue with high concurrency because the merge is
      // simple enough and can't interrupt others
      await this.objectsQueue.addImmutableObject(obj.ref.toString(), () => this.mergeLaneHistory(bitObject));
    } else if (bitObject instanceof Version) {
      // technically it's mutable, but it's ok to have it in the same queue with high concurrency because the merge is
      // simple enough and can't interrupt others
      await this.objectsQueue.addImmutableObject(obj.ref.toString(), () => this.mergeVersionObject(bitObject));
    } else {
      await this.objectsQueue.addImmutableObject(obj.ref.toString(), () => this.writeImmutableObject(bitObject));
    }
  }

  private async writeImmutableObject(bitObject: BitObject) {
    await this.repo.writeObjectsToTheFS([bitObject]);
  }

  private addComponentToComponentsPerRemote(component: ModelComponent) {
    const componentIsPersistPendingAlready = this.repo.objects[component.hash().toString()];
    if (componentIsPersistPendingAlready) {
      // this happens during tag/snap, when all objects are waiting in the repo.objects and only once the tag/snap is
      // completed, all objects are persisted at once. we don't want the import process to interfere and save
      // components objects during the tag/snap.
      return;
    }
    this.componentsPerRemote[this.remoteName].push(component);
  }

  private async mergeVersionHistory(versionHistory: VersionHistory) {
    const existingVersionHistory = (await this.repo.load(versionHistory.hash())) as VersionHistory | undefined;
    if (existingVersionHistory) {
      const operation = this.repo.getNativeImportOperation?.();
      const existing = existingVersionHistory.versions;
      const plan =
        existingVersionHistory.merge === VersionHistory.prototype.merge &&
        versionHistory.merge === VersionHistory.prototype.merge &&
        Object.getPrototypeOf(existingVersionHistory) === VersionHistory.prototype &&
        Object.getPrototypeOf(versionHistory) === VersionHistory.prototype &&
        existingVersionHistory.mergeNative === VersionHistory.prototype.mergeNative &&
        existingVersionHistory.getAllHashesAsString === VersionHistory.prototype.getAllHashesAsString &&
        versionHistory.getAllHashesAsString === VersionHistory.prototype.getAllHashesAsString
          ? await operation?.plan(
              () => ({
                kind: 'versionHistory',
                existing: existingVersionHistory.versions.map((v) => v.hash.toString()),
                incoming: versionHistory.getAllHashesAsString(),
                stored: existingVersionHistory.getAllHashesAsString(),
              }),
              (value) => nativeIndices(value, existing.length)
            )
          : undefined;
      const applied = plan?.apply((retained) => {
        existingVersionHistory.mergeNative(versionHistory, retained);
        return true;
      });
      if (!applied) existingVersionHistory.merge(versionHistory);
      await this.writeMutableObject(existingVersionHistory);
    } else {
      await this.writeMutableObject(versionHistory);
    }
  }

  private async mergeLaneHistory(laneHistory: LaneHistory) {
    const existingLaneHistory = (await this.repo.load(laneHistory.hash())) as LaneHistory | undefined;
    if (existingLaneHistory) {
      const operation = this.repo.getNativeImportOperation?.();
      const existing = Object.keys(existingLaneHistory.getHistory());
      const incoming = Object.keys(laneHistory.getHistory());
      const plan =
        existingLaneHistory.merge === LaneHistory.prototype.merge &&
        laneHistory.merge === LaneHistory.prototype.merge &&
        Object.getPrototypeOf(existingLaneHistory) === LaneHistory.prototype &&
        Object.getPrototypeOf(laneHistory) === LaneHistory.prototype &&
        existingLaneHistory.mergeNative === LaneHistory.prototype.mergeNative &&
        existingLaneHistory.getHistory === LaneHistory.prototype.getHistory &&
        laneHistory.getHistory === LaneHistory.prototype.getHistory
          ? await operation?.plan(
              () => ({
                kind: 'laneHistory',
                existing: Object.keys(existingLaneHistory.getHistory()),
                incoming: Object.keys(laneHistory.getHistory()),
              }),
              (value) => nativeSelections(value, [existing.length, incoming.length])
            )
          : undefined;
      const applied = plan?.apply((selections) => {
        existingLaneHistory.mergeNative(laneHistory, selections);
        return true;
      });
      if (!applied) existingLaneHistory.merge(laneHistory);
      await this.writeMutableObject(existingLaneHistory);
    } else {
      await this.writeMutableObject(laneHistory);
    }
  }

  private async mergeVersionObject(version: Version) {
    const existingVersion = (await this.repo.load(version.hash())) as Version | undefined;
    let isExistingNewer: boolean | undefined;
    if (existingVersion) {
      const oldDate = existingVersion.lastModified();
      const newDate = version.lastModified();
      const operation =
        existingVersion.lastModified === Version.prototype.lastModified &&
        version.lastModified === Version.prototype.lastModified
          ? this.repo.getNativeImportOperation?.()
          : undefined;
      const plan =
        typeof oldDate === 'string' && typeof newDate === 'string'
          ? await operation?.plan(
              () => ({ kind: 'version', existing: existingVersion.lastModified(), incoming: version.lastModified() }),
              (value) => {
                if (typeof value !== 'boolean') throw new Error('invalid native Version decision');
                return value;
              }
            )
          : undefined;
      isExistingNewer = plan?.apply((value) => value);
      isExistingNewer ??= operation ? existingVersion.lastModified() > version.lastModified() : oldDate > newDate;
    }
    if (isExistingNewer) return;
    await this.writeMutableObject(version);
  }

  private nativeStoreEligibility(): boolean | Promise<boolean> {
    if (!this.repo.canWriteMutableObjectsNatively()) return false;
    const eligibility = this.repo.getNativeSourceStoreEligibility?.();
    return eligibility === undefined ? this.repo.getNativeSourceStoreOptions().then(Boolean) : eligibility;
  }

  private beginSequentialMetadata() {
    if (
      process.env.BIT_RUST_OBJECT_IMPORT_SEQUENTIAL === 'on' &&
      this.mutableWriter &&
      this.repo.getNativeImportOperation?.()
    )
      this.sequentialMetadata = [];
  }

  private async flushSequentialMetadata() {
    const pending = this.sequentialMetadata;
    if (!pending?.length) return;
    this.sequentialMetadata = [];
    const eligibility = this.nativeStoreEligibility();
    const sizes = (typeof eligibility === 'boolean' ? eligibility : await eligibility)
      ? await this.mutableWriter?.persistMetadataSequential(pending)
      : undefined;
    for (let index = 0; index < pending.length; index++) {
      const { object, buffer, ref } = pending[index];
      if (sizes?.[index]) this.repo.recordNativeObjectWrite(object, buffer.byteLength, sizes[index]!);
      else
        await this.repo.writeObjectsToTheFS(
          [object],
          new Map([
            [
              object,
              {
                ref,
                buffer: await deflate(buffer),
                inflatedSize: buffer.byteLength,
              },
            ],
          ])
        );
    }
  }

  private async writeMutableObject(object: Version | VersionHistory | LaneHistory) {
    if (!(object instanceof Version)) await this.flushSequentialMetadata();
    const eligibility =
      this.mutableWriter && !this.mutableWriter.unavailableReason ? this.nativeStoreEligibility() : false;
    if (
      this.mutableWriter &&
      !this.mutableWriter.unavailableReason &&
      (typeof eligibility === 'boolean' ? eligibility : await eligibility) &&
      object.serialize === BitObject.prototype.serialize &&
      object.compressWithSize === BitObject.prototype.compressWithSize
    ) {
      const buffer = object.serialize();
      const ref = object.hash();
      if (this.sequentialMetadata && object instanceof Version && buffer.byteLength <= MAX_NATIVE_MUTABLE_BYTES) {
        if (this.sequentialMetadata.length >= 16 || this.sequentialMetadata.some((entry) => entry.ref.isEqual(ref)))
          await this.flushSequentialMetadata();
        this.sequentialMetadata!.push({ object, buffer, ref });
        return;
      }
      await this.flushSequentialMetadata();
      const sizes =
        buffer.byteLength <= MAX_NATIVE_MUTABLE_BYTES
          ? await this.mutableWriter.persistMetadata([{ ref, buffer }])
          : undefined;
      if (sizes?.[0]) {
        this.repo.recordNativeObjectWrite(object, buffer.byteLength, sizes[0]);
        return;
      }
      // Reuse canonical serialization when the measured native crossover or a write failure selects Node.
      await this.repo.writeObjectsToTheFS(
        [object],
        new Map([
          [
            object,
            {
              ref,
              buffer: await deflate(buffer),
              inflatedSize: buffer.byteLength,
            },
          ],
        ])
      );
      return;
    }
    await this.flushSequentialMetadata();
    await this.repo.writeObjectsToTheFS([object]);
  }
}
