// <copyright file="NativeSliceRuntimeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Buffers;
using System.Diagnostics;
using System.Linq;
using Gsharp.Values;
using Xunit;
using Xunit.Abstractions;

namespace GSharp.Compiler.Tests;

/// <summary>ADR-0190 runtime contracts, independently observed through exact arrays and retained refs.</summary>
public sealed class NativeSliceRuntimeTests
{
    private readonly ITestOutputHelper output;

    public NativeSliceRuntimeTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public void ZeroLengthViewsRetainTheirWholeOwner()
    {
        var (view, owner) = CreateRetainedView();
        GC.Collect();
        GC.WaitForPendingFinalizers();
        GC.Collect();
        Assert.True(owner.IsAlive);
        Assert.Equal(3, view.Capacity);
        Assert.Equal(2, view.Subslice(0, 1)[0]);
        GC.KeepAlive(view);
    }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static (Slice<int> View, WeakReference Owner) CreateRetainedView()
    {
        var owner = new[] { 1, 2, 3, 4 };
        return (Slice<int>.FromArray(owner).Subslice(1, 1), new WeakReference(owner));
    }

    [Fact]
    public void ViewsAndDescriptorCopiesShareElementsNotLength()
    {
        var owner = new[] { 10, 20, 30, 40, 50 };
        var slice = Slice<int>.FromArray(owner).Subslice(1, 3);
        var copy = slice;
        slice[0] = 99;
        Assert.Equal(99, owner[1]);
        Assert.Equal(2, copy.Length);
        var appended = slice.Append(77);
        Assert.Equal(3, appended.Length);
        Assert.Equal(2, copy.Length);
        Assert.Equal(77, copy.Subslice(0, 3)[2]);
        Assert.Equal(77, owner[3]);
        var zero = slice.Subslice(1, 1);
        Assert.True(zero.IsEmpty);
        Assert.Equal(3, zero.Capacity);
        Assert.Equal(30, zero.Subslice(0, 1)[0]);
        Assert.Equal(slice.Subslice(1, 2), slice.Slice(1, 2));
        Assert.Equal(slice.Subslice(1, 2, 3), slice.Slice(1, 2, 3));
        Assert.Equal(slice.AsReadOnly().Subslice(1, 2), slice.AsReadOnly().Slice(1, 2));
    }

    [Fact]
    public void LimitedAppendReallocatesAndOldReferenceSurvivesGc()
    {
        var original = Slice<int>.Create(2, 8);
        original[0] = 3;
        original[1] = 5;
        ref var old = ref original[1];
        var limited = original.Subslice(0, 2, 2);
        var grown = limited.Append(7);
        grown[1] = 11;
        GC.Collect();
        old = 13;
        Assert.Equal(13, original[1]);
        Assert.Equal(13, limited[1]);
        Assert.Equal(11, grown[1]);
        Assert.Equal(7, grown[2]);
        Assert.NotEqual(original, grown);
        Assert.Equal(2, limited.Capacity);
    }

    [Fact]
    public void CopiesAndSelfAppendAreMemmoveSafe()
    {
        var owner = new[] { 1, 2, 3, 4, 5 };
        var slice = Slice<int>.FromArray(owner);
        Assert.Equal(4, slice.Subslice(0, 4).CopyTo(slice.Subslice(1, 5)));
        Assert.Equal(new[] { 1, 1, 2, 3, 4 }, owner);
        Assert.Equal(4, slice.Subslice(1, 5).AsReadOnly().CopyTo(slice.Subslice(0, 4)));
        Assert.Equal(new[] { 1, 2, 3, 4, 4 }, owner);
        var head = slice.Subslice(0, 2);
        var doubled = head.AppendRange(head);
        Assert.Equal(new[] { 1, 2, 1, 2, 4 }, owner);
        Assert.Equal(4, doubled.Length);
        var full = doubled.AppendRange(doubled.AsReadOnly());
        Assert.Equal(new[] { 1, 2, 1, 2, 1, 2, 1, 2 }, full.ToArray());
        Assert.Equal(2, head.Length);
    }

    [Fact]
    public void DefaultsNullabilityIdentityHashAndExplicitCopiesAreDistinct()
    {
        Slice<string> empty = default;
        Assert.True(empty.IsEmpty);
        Assert.Equal(0, empty.Capacity);
        Assert.Equal(empty, Slice<string>.FromArray(Array.Empty<string>()));
        Assert.NotEqual(empty, Slice<string>.FromArray(new string[0]));
        Slice<string>? absent = null;
        Assert.False(absent.HasValue);
        Assert.True(((Slice<string>?)empty).HasValue);
        var values = Slice<string>.Create(1, 3);
        Assert.Null(values[0]);
        var before = values.GetHashCode();
        values[0] = "hello";
        Assert.Equal(before, values.GetHashCode());
        var copy = values.ToArray();
        var clone = values.AsReadOnly().Clone();
        Assert.Equal(1, clone.Capacity);
        values[0] = "changed";
        Assert.Equal("hello", copy[0]);
        Assert.Equal("hello", clone[0]);
        values.Subslice(1, 3)[0] = "spare";
        values.Clear();
        Assert.Null(values[0]);
        Assert.Equal("spare", values.Subslice(1, 3)[0]);
    }

    [Fact]
    public void MemorySpanAndWholeArrayBoundariesNeverInventCopies()
    {
        var owner = new[] { 1, 2, 3, 4 };
        var whole = Slice<int>.FromArray(owner);
        Assert.True(whole.TryGetArray(out var recovered));
        Assert.Same(owner, recovered);
        var part = whole.Subslice(1, 3);
        Assert.False(part.TryGetArray(out recovered));
        Assert.Null(recovered);
        Assert.False(whole.Subslice(0, 3).TryGetArray(out _));
        Assert.False(whole.Subslice(0, 3, 3).TryGetArray(out _));
        Assert.True(default(Slice<int>).TryGetArray(out recovered));
        Assert.Same(Array.Empty<int>(), recovered);
        part.AsSpan()[0] = 7;
        part.AsMemory().Span[1] = 8;
        Assert.Equal(new[] { 1, 7, 8, 4 }, owner);
        Assert.True(Slice<int>.TryFromMemory(owner.AsMemory(1, 2), out var memoryView));
        Assert.Equal(2, memoryView.Capacity);
        memoryView[0] = 9;
        Assert.Equal(9, owner[1]);
        Assert.True(ReadOnlySlice<int>.TryFromMemory(owner.AsMemory(1, 2), out var readOnly));
        Assert.Equal(new[] { 9, 8 }, readOnly.AsSpan().ToArray());
        Assert.Equal(2, readOnly.AsMemory().Length);
        using var customOwner = new CustomOwner();
        Assert.False(Slice<int>.TryFromMemory(customOwner.Memory, out _));
        Assert.False(ReadOnlySlice<int>.TryFromMemory(customOwner.Memory, out _));
        Assert.False(Slice<int>.TryFromMemory(customOwner.Memory[..0], out _));
        Assert.False(ReadOnlySlice<int>.TryFromMemory(customOwner.Memory[..0], out _));
        Assert.False(ReadOnlySlice<char>.TryFromMemory("".AsMemory(), out _));
        Assert.False(ReadOnlySlice<char>.TryFromMemory("text".AsMemory(), out _));
        Assert.Null(typeof(ReadOnlySlice<int>).GetMethod("TryGetArray"));
        Assert.Null(typeof(ReadOnlySlice<int>).GetMethod("Clear"));
        Assert.Null(typeof(ReadOnlySlice<int>).GetMethod("Append"));
    }

    [Fact]
    public void FactoriesRejectNullCovariantAndEmptyCovariantOwners()
    {
        Assert.Throws<ArgumentNullException>(() => Slice<string>.FromArray(null));
        foreach (object[] owner in new[] { new[] { "text" }, Array.Empty<string>() })
        {
            Assert.Throws<ArrayTypeMismatchException>(() => Slice<object>.FromArray(owner));
            Assert.Throws<ArrayTypeMismatchException>(() => ReadOnlySlice<object>.FromArray(owner));
        }
    }

    [Theory]
    [InlineData(-1, 0, 3)]
    [InlineData(2, 1, 3)]
    [InlineData(0, 4, 3)]
    [InlineData(0, 0, -1)]
    [InlineData(0, 0, int.MaxValue)]
    public void InvalidSliceBoundsFailBeforeAnyMutation(int lo, int hi, int max)
    {
        var slice = Slice<int>.FromArray(new[] { 1, 2, 3 });
        Assert.Throws<ArgumentOutOfRangeException>(() => slice.Subslice(lo, hi, max));
        Assert.Equal(new[] { 1, 2, 3 }, slice.ToArray());
    }

    [Fact]
    public void ElementAndFactoryBoundsUseSelectedExceptions()
    {
        var slice = Slice<int>.Create(1, 3);
        Assert.Throws<IndexOutOfRangeException>(() => slice[1]);
        Assert.Throws<IndexOutOfRangeException>(() => slice[-1]);
        Assert.Throws<IndexOutOfRangeException>(() => slice[^0]);
        Assert.Throws<IndexOutOfRangeException>(() => slice[-1, true]);
        Assert.Throws<ArgumentOutOfRangeException>(() => Slice<int>.Create(-1, 1));
        Assert.Throws<ArgumentOutOfRangeException>(() => Slice<int>.Create(1, -1));
        Assert.Throws<ArgumentOutOfRangeException>(() => Slice<int>.Create(2, 1));
        Assert.Throws<ArgumentOutOfRangeException>(() => slice.Subslice(-1, 0, true, false));
    }

    [Fact]
    public void EnumerationSavesDescriptorAndReadsCurrentElements()
    {
        var source = Slice<int>.FromArray(new[] { 1, 2, 3 });
        var iterator = source.GetEnumerator();
        Assert.True(iterator.MoveNext());
        Assert.Equal(1, iterator.Current);
        source[1] = 9;
        source = default;
        Assert.True(iterator.MoveNext());
        Assert.Equal(9, iterator.Current);
        Assert.True(iterator.MoveNext());
        Assert.Equal(3, iterator.Current);
        Assert.False(iterator.MoveNext());
    }

    [Fact]
    public void StereoViewsAndInCapacityAppendHaveNoPerOperationAllocation()
    {
        var owner = new StereoFrame[64];
        var frames = Slice<StereoFrame>.FromArray(owner);
        var appends = Slice<int>.Create(0, 1);
        for (var i = 0; i < 20_000; i++)
        {
            Process(frames, appends);
        }

        const int Iterations = 100_000;
        var timer = Stopwatch.StartNew();
        var before = GC.GetAllocatedBytesForCurrentThread();
        for (var i = 0; i < Iterations; i++)
        {
            Process(frames, appends);
        }

        var allocated = GC.GetAllocatedBytesForCurrentThread() - before;
        timer.Stop();
        Assert.Equal(0, allocated);
        Assert.True(timer.Elapsed < TimeSpan.FromSeconds(5), $"Native sanity budget exceeded: {timer.Elapsed}");
        output.WriteLine($"Native: {Iterations} operations, {timer.Elapsed.TotalMilliseconds:F3} ms, {allocated} bytes.");
        Assert.Equal(120_000.0, owner[1].Left);
        Assert.Equal(240_000.0, owner[1].Right);

        Measure("raw array", () => owner[1].Left++, Iterations);
        Measure("BCL memory", () => owner.AsMemory(1, 32).Span[0].Left++, Iterations);
        Measure("explicit range copy", () => owner[1..33][0].Left++, Iterations);
    }

    private static void Process(Slice<StereoFrame> frames, Slice<int> appends)
    {
        var view = frames.Subslice(1, 33);
        view[0].Left++;
        view[0].Right += 2;
        var appended = appends.Append(7);
        if (appended[0] != 7)
        {
            throw new InvalidOperationException();
        }
    }

    private void Measure(string name, Action operation, int iterations)
    {
        var timer = Stopwatch.StartNew();
        var before = GC.GetAllocatedBytesForCurrentThread();
        for (var i = 0; i < iterations; i++)
        {
            operation();
        }

        var bytes = GC.GetAllocatedBytesForCurrentThread() - before;
        timer.Stop();
        output.WriteLine($"{name}: {iterations} operations, {timer.Elapsed.TotalMilliseconds:F3} ms, {bytes} bytes.");
    }

    private struct StereoFrame
    {
        public double Left;
        public double Right;
    }

    private sealed class CustomOwner : MemoryManager<int>
    {
        private readonly int[] storage = new int[4];

        public override Span<int> GetSpan() => storage;

        public override MemoryHandle Pin(int elementIndex = 0) => throw new NotSupportedException();

        public override void Unpin()
        {
        }

        protected override void Dispose(bool disposing)
        {
        }
    }
}
