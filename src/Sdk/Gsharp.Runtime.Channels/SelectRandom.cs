// <copyright file="SelectRandom.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Gsharp.Concurrency;

/// <summary>
/// The uniform-random arm order a G# <c>select</c> probes ready arms in
/// (ADR-0174 D8 step 2 — Go's fairness; wave 1's source-order probing was a
/// semantic divergence programs could come to depend on). Thread-static
/// xoshiro128** state and a thread-static permutation buffer: zero
/// steady-state allocation, safe because the fast path never suspends between
/// <see cref="Shuffle"/> and its use. <c>GSHARP_SELECT_SEED</c> or
/// <see cref="Reseed"/> make a run reproducible for tests.
/// </summary>
public static class SelectRandom
{
    [ThreadStatic]
    private static uint s0;

    [ThreadStatic]
    private static uint s1;

    [ThreadStatic]
    private static uint s2;

    [ThreadStatic]
    private static uint s3;

    [ThreadStatic]
    private static bool seeded;

    [ThreadStatic]
    private static int[]? buffer;

    /// <summary>Returns a uniformly random integer in <c>[0, n)</c>.</summary>
    /// <param name="n">The exclusive upper bound; must be positive.</param>
    /// <returns>A random index.</returns>
    public static int Next(int n)
    {
        if (n <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(n), n, "n must be positive.");
        }

        EnsureSeeded();
        return (int)(NextUInt32() % (uint)n);
    }

    /// <summary>
    /// Returns a Fisher–Yates permutation of <c>0..n-1</c> in a thread-static
    /// buffer. The span is valid until the calling thread's next call.
    /// </summary>
    /// <param name="n">The number of arms.</param>
    /// <returns>The permutation.</returns>
    public static ReadOnlySpan<int> Shuffle(int n)
    {
        if (n < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(n), n, "n must be non-negative.");
        }

        EnsureSeeded();
        var order = buffer;
        if (order is null || order.Length < n)
        {
            order = buffer = new int[Math.Max(n, 8)];
        }

        for (var i = 0; i < n; i++)
        {
            order[i] = i;
        }

        for (var i = n - 1; i > 0; i--)
        {
            var j = (int)(NextUInt32() % (uint)(i + 1));
            (order[i], order[j]) = (order[j], order[i]);
        }

        return new ReadOnlySpan<int>(order, 0, n);
    }

    /// <summary>Reseeds the calling thread's generator; for reproducible tests.</summary>
    /// <param name="seed">The seed.</param>
    public static void Reseed(int seed)
    {
        // SplitMix32 expansion of the seed into four non-zero words.
        var x = (uint)seed;
        s0 = SplitMix(ref x);
        s1 = SplitMix(ref x);
        s2 = SplitMix(ref x);
        s3 = SplitMix(ref x);
        if ((s0 | s1 | s2 | s3) == 0)
        {
            s0 = 1;
        }

        seeded = true;
    }

    private static void EnsureSeeded()
    {
        if (seeded)
        {
            return;
        }

        var env = Environment.GetEnvironmentVariable("GSHARP_SELECT_SEED");
        Reseed(env is not null && int.TryParse(env, out var fixedSeed) ? fixedSeed : Random.Shared.Next());
    }

    private static uint SplitMix(ref uint x)
    {
        x += 0x9E3779B9u;
        var z = x;
        z = (z ^ (z >> 16)) * 0x85EBCA6Bu;
        z = (z ^ (z >> 13)) * 0xC2B2AE35u;
        return z ^ (z >> 16);
    }

    private static uint NextUInt32()
    {
        // xoshiro128**
        var result = RotateLeft(s1 * 5, 7) * 9;
        var t = s1 << 9;
        s2 ^= s0;
        s3 ^= s1;
        s1 ^= s2;
        s0 ^= s3;
        s2 ^= t;
        s3 = RotateLeft(s3, 11);
        return result;
    }

    private static uint RotateLeft(uint x, int k) => (x << k) | (x >> (32 - k));
}
