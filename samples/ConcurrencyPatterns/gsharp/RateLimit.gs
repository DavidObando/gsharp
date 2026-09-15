package Patterns

import System
import System.Collections.Generic
import System.Threading

class Bucket {
    public var Tokens int32
    public var Last int64
    init(tokens int32, last int64) {
        Tokens = tokens
        Last = last
    }
}

class KeyedLimiter {
    private let gate Object = Object()
    private let buckets Dictionary[string, Bucket] = Dictionary[string, Bucket]()
    private let capacity int32
    private let period int64

    init(capacity int32, period int64) {
        verify(capacity > 0 && period > 0, "positive capacity and period required")
        this.capacity = capacity
        this.period = period
    }

    func Allow(key string, now int64) bool {
        lock gate {
            if !buckets.ContainsKey(key) { buckets[key] = Bucket(capacity, now) }
            let bucket = buckets[key]
            verify(now >= bucket.Last, "clock moved backwards")
            let added = (now - bucket.Last) / period
            if added > 0 {
                bucket.Tokens = added >= capacity - bucket.Tokens ? capacity : bucket.Tokens + int32(added)
                bucket.Last += added * period
            }
            if bucket.Tokens == 0 { return false }
            bucket.Tokens--
            return true
        }
    }
}

class RateState { public var Accepted int32 }

func requestToken(limiter KeyedLimiter, state RateState) {
    if limiter.Allow("parallel", 200) { Interlocked.Increment(ref state.Accepted) }
}

func rateLimitExample() {
    let limiter = KeyedLimiter(2, 10)
    verify(limiter.Allow("a", 0) && limiter.Allow("a", 0), "initial burst")
    verify(!limiter.Allow("a", 5), "fractional refill")
    verify(limiter.Allow("b", 5), "independent key")
    verify(limiter.Allow("a", 10) && !limiter.Allow("a", 10), "refill boundary")
    verify(limiter.Allow("a", 100) && limiter.Allow("a", 100) && !limiter.Allow("a", 100), "capacity cap")
    let state = RateState()
    scope {
        for id in 0 ... 40 { go requestToken(limiter, state) }
    }
    verify(state.Accepted == 2, "atomic token admission")
    var rejected = false
    try { limiter.Allow("a", 0) } catch (e InvalidOperationException) {
        rejected = e.Message == "clock moved backwards"
    }
    verify(rejected, "backwards clock")
    Console.WriteLine("rate-limit burst=2 refill=1 parallel=2 rollback=rejected")
}
