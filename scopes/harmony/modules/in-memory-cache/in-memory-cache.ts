import { getNumberFromConfig } from '@teambit/config-store';
import { CFG_CACHE_MAX_ITEMS_COMPONENTS, CFG_CACHE_MAX_ITEMS_OBJECTS } from '@teambit/legacy.constants';

export interface InMemoryCache<T> {
  set(key: string, value: T): void;
  get(key: string): T | undefined;
  delete(key: string): void;
  has(key: string): boolean;
  deleteAll(): void;
  keys(): string[];
}

export type CacheOptions = {
  maxSize?: number;
  maxAge?: number; // in milliseconds
};

export function getMaxSizeForComponents(): number {
  return getNumberFromConfig(CFG_CACHE_MAX_ITEMS_COMPONENTS) || 500;
}

export function getMaxSizeForObjects(): number {
  return getNumberFromConfig(CFG_CACHE_MAX_ITEMS_OBJECTS) || 3000;
}
