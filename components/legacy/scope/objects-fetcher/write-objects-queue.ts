import PQueue from 'p-queue';
import { concurrentIOLimit } from '@teambit/harmony.modules.concurrency';

export class WriteObjectsQueue {
  private queue: PQueue;
  addedHashes: string[] = [];
  private seenHashes = new Set<string>();
  added = 0;
  constructor(concurrency = concurrentIOLimit()) {
    this.queue = new PQueue({ concurrency, autoStart: true });
  }
  addImmutableObject<T>(hash: string, fn: () => Promise<T | null>) {
    if (!this.reserve(hash)) return null;
    return this.add(fn);
  }
  reserveNativeSource(hash: string): boolean {
    if (!this.reserve(hash)) return false;
    this.added += 1;
    this.queue.emit('add');
    return true;
  }
  private reserve(hash: string): boolean {
    if (this.seenHashes.has(hash)) return false;
    this.seenHashes.add(hash);
    this.addedHashes.push(hash);
    return true;
  }
  getQueue() {
    return this.queue;
  }
  add<T>(fn: () => T, priority?: number): Promise<T> {
    this.added += 1;
    return this.queue.add(fn, { priority });
  }
  onIdle(): Promise<void> {
    return this.queue.onIdle();
  }
}
