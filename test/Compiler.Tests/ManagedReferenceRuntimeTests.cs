// <copyright file="ManagedReferenceRuntimeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Threading.Tasks;
using Gsharp.Values;
using Xunit;
using Xunit.Abstractions;

namespace GSharp.Compiler.Tests;

public sealed class ManagedReferenceRuntimeTests
{
    /// <summary>
    /// The size of one array-location handle (<c>ArrayLocation</c>: object
    /// header, method table, owner, index and the lazily filled location-key
    /// slot). Each measured loop below may allocate at most one per iteration.
    /// </summary>
    private const long BytesPerHandle = 40;

    /// <summary>
    /// Issue #4630: allocations the runtime makes ONCE on this thread while a
    /// measured loop runs, independent of the iteration count. A 20,000-trip loop
    /// in a Tier-0 method is promoted by on-stack replacement mid-loop, and that
    /// transition can allocate on the current thread. CI measured exactly
    /// 20,000 x 40 + 24,624 bytes twice, failing a bound that had no slack. 64 KiB
    /// is more than twice that observation, and still far below what ONE extra
    /// object per iteration costs (20,000 x 24 = 480,000 bytes), so a regression
    /// that allocates per operation still fails.
    /// </summary>
    private const long OneTimeRuntimeAllowanceBytes = 64 * 1024;

    private readonly ITestOutputHelper output;

    public ManagedReferenceRuntimeTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public void ArraySliceAndPermissionViewsShareCanonicalLocations()
    {
        var array = new[] { 1, 2, 3 };
        var direct = ManagedRef<int>.FromArray(array, 1);
        var slice = Slice<int>.FromArray(array).Subslice(1, 2, 2);
        var fromSlice = slice.GetManagedReference(0);
        var readOnly = slice.AsReadOnly().GetReadOnlyManagedReference(0);
        var directReadOnly = ReadOnlyManagedRef<int>.FromArray(array, 1);
        Assert.NotSame(direct, fromSlice);
        Assert.True(direct == fromSlice);
        Assert.True(direct.SameLocation(readOnly));
        Assert.True(direct.SameLocation(directReadOnly));
        Assert.True(readOnly.Equals(directReadOnly));
        Assert.Equal(direct.GetHashCode(), readOnly.GetHashCode());
        Assert.Equal(direct.GetHashCode(), directReadOnly.GetHashCode());
        var hash = direct.GetHashCode();
        ref readonly var observed = ref readOnly.Borrow();
        var grown = slice.Append(4);
        direct.Borrow() = 17;
        Assert.Equal(17, observed);
        Assert.Equal(17, array[1]);
        Assert.Equal(2, grown[0]);
        Assert.Equal(hash, direct.GetHashCode());
        Assert.False(direct.SameLocation(ManagedRef<int>.FromArray(array, 0)));
        Assert.False(direct.SameLocation(ManagedRef<int>.FromArray(new[] { 1, 17, 3 }, 1)));
    }

    [Fact]
    public void ArrayLocationIdentityIsLazyCachedAndSafelyPublished()
    {
        const int Iterations = 20_000;
        var owner = new[] { 7 };
        WarmLocationFactories(owner);

        var checksum = 0;
        var before = GC.GetAllocatedBytesForCurrentThread();
        for (var i = 0; i < Iterations; i++)
        {
            checksum += ManagedRef<int>.FromArray(owner, 0).Borrow();
        }

        var immediateBytes = GC.GetAllocatedBytesForCurrentThread() - before;
        var retained = new ManagedRef<int>[Iterations];
        before = GC.GetAllocatedBytesForCurrentThread();
        for (var i = 0; i < retained.Length; i++)
        {
            retained[i] = ManagedRef<int>.FromArray(owner, 0);
        }

        var retainedBytes = GC.GetAllocatedBytesForCurrentThread() - before;
        var readOnly = new ReadOnlyManagedRef<int>[Iterations];
        before = GC.GetAllocatedBytesForCurrentThread();
        for (var i = 0; i < readOnly.Length; i++)
        {
            readOnly[i] = ReadOnlyManagedRef<int>.FromArray(owner, 0);
        }

        var readOnlyBytes = GC.GetAllocatedBytesForCurrentThread() - before;
        var keys = new ManagedLocationKey[Iterations];
        before = GC.GetAllocatedBytesForCurrentThread();
        for (var i = 0; i < retained.Length; i++)
        {
            keys[i] = retained[i].GetLocation();
        }

        var firstIdentityBytes = GC.GetAllocatedBytesForCurrentThread() - before;
        before = GC.GetAllocatedBytesForCurrentThread();
        for (var i = 0; i < retained.Length; i++)
        {
            Assert.Same(keys[i], retained[i].GetLocation());
        }

        var warmedIdentityBytes = GC.GetAllocatedBytesForCurrentThread() - before;
        var concurrentlyObserved = new ManagedLocationKey[Environment.ProcessorCount * 4];
        Parallel.For(0, concurrentlyObserved.Length, i => concurrentlyObserved[i] = readOnly[0].GetLocation());

        Assert.Equal(Iterations * 7, checksum);
        const long AllocationCeiling = (Iterations * BytesPerHandle) + OneTimeRuntimeAllowanceBytes;
        Assert.InRange(immediateBytes, 1, AllocationCeiling);
        Assert.InRange(retainedBytes, 1, AllocationCeiling);
        Assert.InRange(readOnlyBytes, 1, AllocationCeiling);
        Assert.InRange(firstIdentityBytes, 1, AllocationCeiling);
        Assert.Equal(0, warmedIdentityBytes);
        Assert.All(concurrentlyObserved, key => Assert.Same(concurrentlyObserved[0], key));
        this.output.WriteLine(
            $"iterations={Iterations}; immediate={immediateBytes}; retained={retainedBytes}; " +
            $"readonly={readOnlyBytes}; first-identity={firstIdentityBytes}; warmed-identity={warmedIdentityBytes}");
        GC.KeepAlive(retained);
        GC.KeepAlive(readOnly);
    }

    [Fact]
    public void ChecksRejectCovarianceNullAndLengthRatherThanCapacity()
    {
        object[] covariant = new string[] { "value" };
        Assert.Throws<ArrayTypeMismatchException>(() => ManagedRef<object>.FromArray(covariant, 0));
        Assert.Throws<ArrayTypeMismatchException>(() => ReadOnlyManagedRef<object>.FromArray(covariant, 0));
        Assert.Throws<IndexOutOfRangeException>(() => ManagedRef<int>.FromArray(new[] { 1 }, 1));
        Assert.Throws<IndexOutOfRangeException>(() => Slice<int>.Create(1, 4).GetManagedReference(1));
        Assert.Throws<IndexOutOfRangeException>(() => Slice<int>.Create(1, 4).AsReadOnly().GetReadOnlyManagedReference(1));
        ManagedRef<int> nil = null;
        Assert.True(nil == null);
        Assert.False(nil == ManagedRef<int>.FromArray(new[] { 0 }, 0));
    }

    [Fact]
    public void OwnerSurvivesMovingCollectionsWithoutPinning()
    {
        var (handle, readOnlyHandle, owner, readOnlyOwner) = Retain();
        GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: true);
        GC.WaitForPendingFinalizers();
        GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: true);
        Assert.True(owner.IsAlive);
        Assert.True(readOnlyOwner.IsAlive);
        handle.Borrow() = 23;
        Assert.Equal(23, handle.Borrow());
        Assert.Equal(29, readOnlyHandle.Borrow());
        GC.KeepAlive(handle);
        GC.KeepAlive(readOnlyHandle);
    }

    [Fact]
    public void WarmDereferencesAllocateNothingAgainstBorrowAndCellBaselines()
    {
        // Predeclared sanity budgets, not a portable throughput promise.
        const int iterations = 1_000_000;
        var budget = TimeSpan.FromSeconds(5);
        var array = new[] { 0 };
        var handle = ManagedRef<int>.FromArray(array, 0);
        var cell = new StrongBox<int>(0);
        for (var i = 0; i < 10_000; i++)
        {
            handle.Borrow()++;
        }

        var stopwatch = Stopwatch.StartNew();
        var before = GC.GetAllocatedBytesForCurrentThread();
        for (var i = 0; i < iterations; i++)
        {
            handle.Borrow()++;
        }

        var allocated = GC.GetAllocatedBytesForCurrentThread() - before;
        var handleTime = stopwatch.Elapsed;
        stopwatch.Restart();
        ref var direct = ref array[0];
        for (var i = 0; i < iterations; i++)
        {
            direct++;
        }

        var borrowTime = stopwatch.Elapsed;
        stopwatch.Restart();
        for (var i = 0; i < iterations; i++)
        {
            cell.Value++;
        }

        var cellTime = stopwatch.Elapsed;
        Assert.Equal(0, allocated);
        Assert.Equal((iterations * 2) + 10_000, array[0]);
        Assert.Equal(iterations, cell.Value);
        Assert.True(handleTime < budget, handleTime.ToString());
        this.output.WriteLine($"iterations={iterations}; allocations={allocated}; handle={handleTime}; borrowed={borrowTime}; StrongBox={cellTime}; budget={budget}");
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void WarmLocationFactories(int[] owner)
    {
        _ = ManagedRef<int>.FromArray(owner, 0).Borrow();
        _ = ReadOnlyManagedRef<int>.FromArray(owner, 0).Borrow();
        _ = ManagedRef<int>.FromArray(owner, 0).GetLocation();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static (ManagedRef<int> Handle, ReadOnlyManagedRef<int> ReadOnlyHandle, WeakReference Owner, WeakReference ReadOnlyOwner) Retain()
    {
        var owner = new[] { 7 };
        var readOnlyOwner = new[] { 29 };
        return (
            ManagedRef<int>.FromArray(owner, 0),
            ReadOnlyManagedRef<int>.FromArray(readOnlyOwner, 0),
            new WeakReference(owner),
            new WeakReference(readOnlyOwner));
    }
}
