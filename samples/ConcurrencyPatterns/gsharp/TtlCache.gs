package Patterns

import System
import System.Collections.Generic
import System.Threading

data class CacheEntry(Value string, Expires int64)

class TtlCache {
    private let gate ReaderWriterLockSlim = ReaderWriterLockSlim()
    private let entries Dictionary[string, CacheEntry] = Dictionary[string, CacheEntry]()
    private let ttl int64
    private let now() -> int64

    init(ttl int64, now() -> int64) {
        verify(ttl > 0, "TTL must be positive")
        this.ttl = ttl
        this.now = now
    }

    func Set(key string, value string) {
        gate.EnterWriteLock()
        defer gate.ExitWriteLock()
        let tick = now()
        verify(tick >= 0 && tick <= Int64.MaxValue - ttl, "TTL overflow")
        entries[key] = CacheEntry(value, tick + ttl)
    }

    func Get(key string) string? {
        gate.EnterReadLock()
        defer gate.ExitReadLock()
        if !entries.ContainsKey(key) {
            return nil
        }
        let entry = entries[key]
        return now() < entry.Expires ? entry.Value: nil
    }

    func Dispose() {
        gate.Dispose()
    }
}

func cacheAccess(cache TtlCache, id int32) {
    let key = id.ToString()
    cache.Set(key, key)
    verify(cache.Get(key) == key, "concurrent cache access")
}

func ttlCacheExample() {
    var tick int64 = 0
    let cache = TtlCache(10, () -> tick)
    try {
        verify(cache.Get("missing") == nil, "missing cache entry")
        cache.Set("a", "value")
        tick = 9
        verify(cache.Get("a") == "value", "early expiry")
        tick = 10
        verify(cache.Get("a") == nil, "expiry boundary")
        scope {
            for id in 0 ... 40 {
                go cacheAccess(cache, id)
            }
        }
        tick = Int64.MaxValue
        var rejected = false
        try {
            cache.Set("overflow", "value")
        } catch (e InvalidOperationException) {
            rejected = e.Message == "TTL overflow"
        }
        verify(rejected, "expiry overflow")
    } finally {
        cache.Dispose()
    }
    Console.WriteLine("ttl-cache hit=1 expired=1 missing=1 concurrent=40")
}
