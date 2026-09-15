package main

import (
	"fmt"
	"math"
	"strconv"
	"sync"
)

type cacheEntry struct {
	value   string
	expires int64
}

type ttlCache struct {
	mu      sync.RWMutex
	entries map[string]cacheEntry
	ttl     int64
	now     func() int64
}

func newCache(ttl int64, now func() int64) *ttlCache {
	verify(ttl > 0 && now != nil, "positive TTL and a clock are required")
	return &ttlCache{entries: make(map[string]cacheEntry), ttl: ttl, now: now}
}

func (c *ttlCache) set(key, value string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	tick := c.now()
	verify(tick >= 0 && tick <= math.MaxInt64-c.ttl, "TTL overflow")
	c.entries[key] = cacheEntry{value, tick + c.ttl}
}

func (c *ttlCache) get(key string) (string, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	entry, ok := c.entries[key]
	if !ok || c.now() >= entry.expires {
		return "", false
	}
	return entry.value, true
}

func ttlCacheExample() {
	var tick int64
	cache := newCache(10, func() int64 { return tick })
	_, present := cache.get("missing")
	verify(!present, "missing cache entry")
	cache.set("a", "value")
	tick = 9
	value, present := cache.get("a")
	verify(present && value == "value", "early expiry")
	tick = 10
	_, present = cache.get("a")
	verify(!present, "expiry boundary")
	var workers sync.WaitGroup
	for id := range 40 {
		workers.Go(func() {
			key := strconv.Itoa(id)
			cache.set(key, key)
			value, ok := cache.get(key)
			verify(ok && value == key, "concurrent cache access")
		})
	}
	workers.Wait()
	tick = math.MaxInt64
	rejected := false
	func() {
		defer func() { rejected = recover() == "TTL overflow" }()
		cache.set("overflow", "value")
	}()
	verify(rejected, "expiry overflow")
	fmt.Println("ttl-cache hit=1 expired=1 missing=1 concurrent=40")
}
