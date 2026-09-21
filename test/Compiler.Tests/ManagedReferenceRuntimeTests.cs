// <copyright file="ManagedReferenceRuntimeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.Runtime.CompilerServices;
using Gsharp.Values;
using Xunit;
using Xunit.Abstractions;

namespace GSharp.Compiler.Tests;

public sealed class ManagedReferenceRuntimeTests
{
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
        Assert.NotSame(direct, fromSlice);
        Assert.True(direct == fromSlice);
        Assert.True(direct.SameLocation(readOnly));
        Assert.Equal(direct.GetHashCode(), readOnly.GetHashCode());
        var hash = direct.GetHashCode();
        ref readonly var observed = ref readOnly.Borrow();
        var grown = slice.Append(4);
        ref var writable = ref direct.Borrow();
        writable = 17;
        Assert.Equal(17, observed);
        Assert.Equal(17, array[1]);
        Assert.Equal(2, grown[0]);
        Assert.Equal(hash, direct.GetHashCode());
        Assert.False(direct.SameLocation(ManagedRef<int>.FromArray(array, 0)));
        Assert.False(direct.SameLocation(ManagedRef<int>.FromArray(new[] { 1, 17, 3 }, 1)));
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
        var (handle, owner) = Retain();
        GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: true);
        GC.WaitForPendingFinalizers();
        GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: true);
        Assert.True(owner.IsAlive);
        ref var writable = ref handle.Borrow();
        writable = 23;
        Assert.Equal(23, handle.Borrow());
        GC.KeepAlive(handle);
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
            Increment(handle);
        }

        var stopwatch = Stopwatch.StartNew();
        var before = GC.GetAllocatedBytesForCurrentThread();
        for (var i = 0; i < iterations; i++)
        {
            Increment(handle);
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
    private static void Increment(ManagedRef<int> handle)
    {
        ref var value = ref handle.Borrow();
        value++;
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static (ManagedRef<int> Handle, WeakReference Owner) Retain()
    {
        var owner = new[] { 7 };
        return (ManagedRef<int>.FromArray(owner, 0), new WeakReference(owner));
    }
}
