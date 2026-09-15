package main

import (
	"fmt"
	"sync"
	"sync/atomic"
)

type bucket struct {
	tokens int
	last   int64
}

type keyedLimiter struct {
	mu       sync.Mutex
	buckets  map[string]*bucket
	capacity int
	period   int64
}

func (l *keyedLimiter) allow(key string, now int64) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{l.capacity, now}
		l.buckets[key] = b
	}
	verify(now >= b.last, "clock moved backwards")
	added := (now - b.last) / l.period
	if added > 0 {
		if added >= int64(l.capacity-b.tokens) {
			b.tokens = l.capacity
		} else {
			b.tokens += int(added)
		}
		b.last += added * l.period
	}
	if b.tokens == 0 {
		return false
	}
	b.tokens--
	return true
}

func rateLimitExample() {
	limiter := &keyedLimiter{buckets: make(map[string]*bucket), capacity: 2, period: 10}
	verify(limiter.allow("a", 0) && limiter.allow("a", 0), "initial burst")
	verify(!limiter.allow("a", 5), "fractional refill")
	verify(limiter.allow("b", 5), "independent key")
	verify(limiter.allow("a", 10) && !limiter.allow("a", 10), "refill boundary")
	verify(limiter.allow("a", 100) && limiter.allow("a", 100) && !limiter.allow("a", 100), "capacity cap")
	var accepted atomic.Int32
	var workers sync.WaitGroup
	for range 40 {
		workers.Go(func() {
			if limiter.allow("parallel", 200) {
				accepted.Add(1)
			}
		})
	}
	workers.Wait()
	verify(accepted.Load() == 2, "atomic token admission")
	rejected := false
	func() {
		defer func() { rejected = recover() == "clock moved backwards" }()
		limiter.allow("a", 0)
	}()
	verify(rejected, "backwards clock")
	fmt.Println("rate-limit burst=2 refill=1 parallel=2 rollback=rejected")
}
