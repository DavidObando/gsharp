// <copyright file="SelectRandom.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.Concurrency

import System

/// The uniform-random arm order a G# `select` probes ready arms in
/// (ADR-0174 D8 step 2 — Go's fairness; wave 1's source-order probing was a
/// semantic divergence programs could come to depend on). Thread-static
/// xoshiro128** state and a thread-static permutation buffer: zero
/// steady-state allocation, safe because the fast path never suspends between
/// (cref:Shuffle) and its use. `GSHARP_SELECT_SEED` or
/// (cref:Reseed) make a run reproducible for tests.
shared class SelectRandom {
    @ThreadStatic
    private var s0 uint32

    @ThreadStatic
    private var s1 uint32

    @ThreadStatic
    private var s2 uint32

    @ThreadStatic
    private var s3 uint32

    @ThreadStatic
    private var seeded bool

    @ThreadStatic
    private var buffer[]?int32

    /// Returns a uniformly random integer in `[0, n)`.
    /// @param n The exclusive upper bound; must be positive.
    /// @returns A random index.
    func Next(n int32) int32 {
        if n <= 0 {
            throw ArgumentOutOfRangeException("n", n, "n must be positive.")
        }
        EnsureSeeded()
        return int32((NextUInt32() % uint32(n)))
    }

    /// Returns a Fisher–Yates permutation of `0..n-1` in a thread-static
    /// buffer. The span is valid until the calling thread's next call.
    /// @param n The number of arms.
    /// @returns The permutation.
    func Shuffle(n int32) ReadOnlySpan[int32] {
        if n < 0 {
            throw ArgumentOutOfRangeException("n", n, "n must be non-negative.")
        }
        EnsureSeeded()
        var order[]?int32 = buffer
        if order == nil || order.Length < n {
            order = (buffer = [Math.Max(n, 8)]int32)
        }
        for var i = 0; i < n; i++ {
            order[i] = i
        }
        for var i = n - 1; i > 0; i-- {
            let j = int32((NextUInt32() % uint32((i + 1))))
            order[i], order[j] = order[j], order[i]
        }
        return ReadOnlySpan[int32](order, 0, n)
    }

    /// Reseeds the calling thread's generator; for reproducible tests.
    /// @param seed The seed.
    func Reseed(seed int32) {
        // SplitMix32 expansion of the seed into four non-zero words.
        var x = uint32(seed)
        s0 = SplitMix(&x)
        s1 = SplitMix(&x)
        s2 = SplitMix(&x)
        s3 = SplitMix(&x)
        if (s0 | s1 | s2 | s3) == uint32(0) {
            s0 = uint32(1)
        }
        seeded = true
    }

    private func EnsureSeeded() {
        if seeded {
            return
        }
        let env string? = Environment.GetEnvironmentVariable("GSHARP_SELECT_SEED")
        Reseed(
            if env != nil && int32.TryParse(env, out var fixedSeed) {
                fixedSeed
            } else {
                Random.Shared.Next()
            }
        )
    }

    private func SplitMix(ref x uint32) uint32 {
        x += 0x9E3779B9u
        var z = x
        z = (z ^ (z >> 16)) * 0x85EBCA6Bu
        z = (z ^ (z >> 13)) * 0xC2B2AE35u
        return z ^ (z >> 16)
    }

    private func NextUInt32() uint32 {
        // xoshiro128**
        let result = RotateLeft(s1 * uint32(5), 7) * uint32(9)
        let t = s1 << 9
        s2 ^= s0
        s3 ^= s1
        s1 ^= s2
        s0 ^= s3
        s2 ^= t
        s3 = RotateLeft(s3, 11)
        return result
    }

    private func RotateLeft(x uint32, k int32) uint32 -> (x << k) | (x >> (32 - k))
}
