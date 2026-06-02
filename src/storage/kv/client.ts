export interface CacheEntry<T> {
  value: T;
  stored_at: string;   // ISO timestamp — used for freshness checks
  ttl_seconds: number; // TTL the data was stored with
}

// Freshness score: 1.0 = just stored, decays exponentially to 0 at TTL.
// Mirrors the same formula used in the signal aggregator.
export function cacheEntryFreshness<T>(entry: CacheEntry<T>): number {
  const elapsedSeconds = (Date.now() - new Date(entry.stored_at).getTime()) / 1000;
  return Math.exp(-elapsedSeconds / entry.ttl_seconds);
}

export class KVClient {
  constructor(private kv: KVNamespace) {}

  async get<T = unknown>(key: string): Promise<T | null> {
    const value = await this.kv.get(key, "text");
    if (value === null) return null;
    return JSON.parse(value) as T;
  }

  async getString(key: string): Promise<string | null> {
    return this.kv.get(key, "text");
  }

  async set<T = unknown>(
    key: string,
    value: T,
    ttlSeconds?: number
  ): Promise<void> {
    const options: KVNamespacePutOptions = {};
    if (ttlSeconds) {
      options.expirationTtl = ttlSeconds;
    }
    await this.kv.put(key, JSON.stringify(value), options);
  }

  async setString(
    key: string,
    value: string,
    ttlSeconds?: number
  ): Promise<void> {
    const options: KVNamespacePutOptions = {};
    if (ttlSeconds) {
      options.expirationTtl = ttlSeconds;
    }
    await this.kv.put(key, value, options);
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key);
  }

  async list(prefix?: string): Promise<string[]> {
    const result = await this.kv.list({ prefix });
    return result.keys.map((k) => k.name);
  }

  async getOrSet<T>(
    key: string,
    factory: () => Promise<T>,
    ttlSeconds?: number
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    const value = await factory();
    await this.set(key, value, ttlSeconds);
    return value;
  }

  // Stores value with freshness metadata so callers can compute temporal decay.
  async setTracked<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    const entry: CacheEntry<T> = {
      value,
      stored_at: new Date().toISOString(),
      ttl_seconds: ttlSeconds,
    };
    await this.set(key, entry, ttlSeconds);
  }

  // Returns the value with its freshness score (0.0 → 1.0).
  // Returns null if the key doesn't exist or the entry isn't a tracked CacheEntry.
  async getTracked<T>(key: string): Promise<{ value: T; freshness: number } | null> {
    const entry = await this.get<CacheEntry<T>>(key);
    if (!entry || !entry.stored_at) return null;
    return {
      value: entry.value,
      freshness: cacheEntryFreshness(entry),
    };
  }
}

export function createKVClient(kv: KVNamespace): KVClient {
  return new KVClient(kv);
}
