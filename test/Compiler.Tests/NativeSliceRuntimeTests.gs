// <copyright file="NativeSliceRuntimeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import Gsharp.Values
import System
import System.Buffers
import System.Diagnostics
import System.Linq
import System.Runtime.CompilerServices
import Xunit
import Xunit.Abstractions

/// ADR-0190 runtime contracts, independently observed through exact arrays and retained refs.
class NativeSliceRuntimeTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    @Fact
    func ZeroLengthViewsRetainTheirWholeOwner() {
        let (view, owner) = CreateRetainedView()
        GC.Collect()
        GC.WaitForPendingFinalizers()
        GC.Collect()
        Assert.True(owner.IsAlive)
        Assert.Equal(3, view.Capacity)
        Assert.Equal(2, view.Subslice(0, 1)[0])
        GC.KeepAlive(view)
    }

    @Fact
    func ViewsAndDescriptorCopiesShareElementsNotLength() {
        let owner = []int32{10, 20, 30, 40, 50}
        var slice = Gsharp.Values.Slice[int32].FromArray(owner).Subslice(1, 3)
        let copy = slice
        slice[0] = 99
        Assert.Equal(99, owner[1])
        Assert.Equal(2, copy.Length)
        let appended = slice.Append(77)
        Assert.Equal(3, appended.Length)
        Assert.Equal(2, copy.Length)
        Assert.Equal(77, copy.Subslice(0, 3)[2])
        Assert.Equal(77, owner[3])
        let zero = slice.Subslice(1, 1)
        Assert.True(zero.IsEmpty)
        Assert.Equal(3, zero.Capacity)
        Assert.Equal(30, zero.Subslice(0, 1)[0])
        Assert.Equal(slice.Subslice(1, 2), slice.Slice(1, 2))
        Assert.Equal(slice.Subslice(1, 2, 3), slice.Slice(1, 2, 3))
        Assert.Equal(slice.AsReadOnly().Subslice(1, 2), slice.AsReadOnly().Slice(1, 2))
    }

    @Fact
    func LimitedAppendReallocatesAndOldReferenceSurvivesGc() {
        var original = slice[int32].Create(2, 8)
        original[0] = 3
        original[1] = 5
        var ref old int32 = original[1]
        let limited = original.Subslice(0, 2, 2)
        var grown = limited.Append(7)
        grown[1] = 11
        GC.Collect()
        old = 13
        Assert.Equal(13, original[1])
        Assert.Equal(13, limited[1])
        Assert.Equal(11, grown[1])
        Assert.Equal(7, grown[2])
        Assert.NotEqual(original, grown)
        Assert.Equal(2, limited.Capacity)
    }

    @Fact
    func CopiesAndSelfAppendAreMemmoveSafe() {
        let owner = []int32{1, 2, 3, 4, 5}
        let slice = Gsharp.Values.Slice[int32].FromArray(owner)
        Assert.Equal(4, slice.Subslice(0, 4).CopyTo(slice.Subslice(1, 5)))
        Assert.Equal([]int32{1, 1, 2, 3, 4}, owner)
        Assert.Equal(4, slice.Subslice(1, 5).AsReadOnly().CopyTo(slice.Subslice(0, 4)))
        Assert.Equal([]int32{1, 2, 3, 4, 4}, owner)
        let head = slice.Subslice(0, 2)
        let doubled = head.AppendRange(head)
        Assert.Equal([]int32{1, 2, 1, 2, 4}, owner)
        Assert.Equal(4, doubled.Length)
        let full = doubled.AppendRange(doubled.AsReadOnly())
        Assert.Equal([]int32{1, 2, 1, 2, 1, 2, 1, 2}, full.ToArray())
        Assert.Equal(2, head.Length)
    }

    @Fact
    func DefaultsNullabilityIdentityHashAndExplicitCopiesAreDistinct() {
        let empty = default(slice[string])
        Assert.True(empty.IsEmpty)
        Assert.Equal(0, empty.Capacity)
        Assert.Equal(empty, slice[string].FromArray(Array.Empty[string]()))
        Assert.NotEqual(empty, slice[string].FromArray([0]string))
        let absent slice[string]? = nil
        Assert.False((absent != nil))
        Assert.True(((cast[slice[string]?](empty)) != nil))
        var values = slice[string].Create(1, 3)
        Assert.Null(values[0])
        let before = values.GetHashCode()
        values[0] = "hello"
        Assert.Equal(before, values.GetHashCode())
        let copy = values.ToArray()
        let clone = values.AsReadOnly().Clone()
        Assert.Equal(1, clone.Capacity)
        values[0] = "changed"
        Assert.Equal("hello", copy[0])
        Assert.Equal("hello", clone[0])
        values.Subslice(1, 3)[0] = "spare"
        values.Clear()
        Assert.Null(values[0])
        Assert.Equal("spare", values.Subslice(1, 3)[0])
    }

    @Fact
    func MemorySpanAndWholeArrayBoundariesNeverInventCopies() {
        let owner = []int32{1, 2, 3, 4}
        let whole = slice[int32].FromArray(owner)
        Assert.True(whole.TryGetArray(out var recovered))
        Assert.Same(owner, recovered)
        let part = whole.Subslice(1, 3)
        Assert.False(part.TryGetArray(out recovered))
        Assert.Null(recovered)
        Assert.False(whole.Subslice(0, 3).TryGetArray(out _))
        Assert.False(whole.Subslice(0, 3, 3).TryGetArray(out _))
        Assert.True(default(slice[int32]).TryGetArray(out recovered))
        Assert.Same(Array.Empty[int32](), recovered)
        part.AsSpan()[0] = 7
        part.AsMemory().Span[1] = 8
        Assert.Equal([]int32{1, 7, 8, 4}, owner)
        Assert.True(slice[int32].TryFromMemory(owner.AsMemory(1, 2), out var memoryView))
        Assert.Equal(2, memoryView.Capacity)
        memoryView[0] = 9
        Assert.Equal(9, owner[1])
        Assert.True(readonly slice[int32].TryFromMemory(owner.AsMemory(1, 2), out var readOnly))
        Assert.Equal([]int32{9, 8}, readOnly.AsSpan().ToArray())
        Assert.Equal(2, readOnly.AsMemory().Length)
        using let customOwner = CustomOwner()
        Assert.False(slice[int32].TryFromMemory(customOwner.Memory, out _))
        Assert.False(readonly slice[int32].TryFromMemory(customOwner.Memory, out _))
        Assert.False(slice[int32].TryFromMemory(customOwner.Memory[.. 0], out _))
        Assert.False(readonly slice[int32].TryFromMemory(customOwner.Memory[.. 0], out _))
        Assert.False(readonly slice[char].TryFromMemory("".AsMemory(), out _))
        Assert.False(readonly slice[char].TryFromMemory("text".AsMemory(), out _))
        Assert.Null(typeof(readonly slice[int32]).GetMethod("TryGetArray"))
        Assert.Null(typeof(readonly slice[int32]).GetMethod("Clear"))
        Assert.Null(typeof(readonly slice[int32]).GetMethod("Append"))
    }

    @Fact
    func FactoriesRejectNullCovariantAndEmptyCovariantOwners() {
        Assert.Throws[ArgumentNullException](
            func () object? {
                return slice[string].FromArray(default([]string))
            }
        )
        for owner[]object in[][]string{[]string{"text"}, Array.Empty[string]()} {
            Assert.Throws[ArrayTypeMismatchException](
                func () object? {
                    return slice[object].FromArray(owner)
                }
            )
            Assert.Throws[ArrayTypeMismatchException](
                func () object? {
                    return readonly slice[object].FromArray(owner)
                }
            )
        }
    }

    @Theory
    @InlineData(int32(-1), int32(0), int32(3))
    @InlineData(int32(2), int32(1), int32(3))
    @InlineData(int32(0), int32(4), int32(3))
    @InlineData(int32(0), int32(0), int32(-1))
    @InlineData(int32(0), int32(0), int32(2147483647))
    func InvalidSliceBoundsFailBeforeAnyMutation(lo int32, hi int32, max int32) {
        let slice = Gsharp.Values.Slice[int32].FromArray([]int32{1, 2, 3})
        Assert.Throws[ArgumentOutOfRangeException](
            func () object? {
                return slice.Subslice(lo, hi, max)
            }
        )
        Assert.Equal([]int32{1, 2, 3}, slice.ToArray())
    }

    @Fact
    func ElementAndFactoryBoundsUseSelectedExceptions() {
        let slice = Gsharp.Values.Slice[int32].Create(1, 3)
        Assert.Throws[IndexOutOfRangeException](
            func () object? {
                return slice[1]
            }
        )
        Assert.Throws[IndexOutOfRangeException](
            func () object? {
                return slice[-1]
            }
        )
        Assert.Throws[IndexOutOfRangeException](
            func () object? {
                return slice[^0]
            }
        )
        Assert.Throws[IndexOutOfRangeException](
            func () object? {
                return slice[-1, true]
            }
        )
        Assert.Throws[ArgumentOutOfRangeException](
            func () object? {
                return Gsharp.Values.Slice[int32].Create(-1, 1)
            }
        )
        Assert.Throws[ArgumentOutOfRangeException](
            func () object? {
                return Gsharp.Values.Slice[int32].Create(1, -1)
            }
        )
        Assert.Throws[ArgumentOutOfRangeException](
            func () object? {
                return Gsharp.Values.Slice[int32].Create(2, 1)
            }
        )
        Assert.Throws[ArgumentOutOfRangeException](
            func () object? {
                return slice.Subslice(-1, 0, true, false)
            }
        )
    }

    @Fact
    func EnumerationSavesDescriptorAndReadsCurrentElements() {
        var source = slice[int32].FromArray([]int32{1, 2, 3})
        var iterator = source.GetEnumerator()
        Assert.True(iterator.MoveNext())
        Assert.Equal(1, iterator.Current)
        source[1] = 9
        source = default(slice[int32])
        Assert.True(iterator.MoveNext())
        Assert.Equal(9, iterator.Current)
        Assert.True(iterator.MoveNext())
        Assert.Equal(3, iterator.Current)
        Assert.False(iterator.MoveNext())
    }

    @Fact
    func StereoViewsAndInCapacityAppendHaveNoPerOperationAllocation() {
        let owner = [64]StereoFrame
        let frames = slice[StereoFrame].FromArray(owner)
        let appends = slice[int32].Create(0, 1)
        for var i = 0; i < 20_000; i++ {
            NativeSliceRuntimeTests.Process(frames, appends)
        }
        const Iterations = 100_000
        let timer = Stopwatch.StartNew()
        let before = GC.GetAllocatedBytesForCurrentThread()
        for var i = 0; i < Iterations; i++ {
            NativeSliceRuntimeTests.Process(frames, appends)
        }
        let allocated = GC.GetAllocatedBytesForCurrentThread() - before
        timer.Stop()
        Assert.Equal(int64(0), allocated)
        Assert.True(timer.Elapsed < TimeSpan.FromSeconds(5), "Native sanity budget exceeded: ${timer.Elapsed}")
        output.WriteLine("Native: $Iterations operations, ${timer.Elapsed.TotalMilliseconds:F3} ms, $allocated bytes.")
        Assert.Equal(120_000.0, owner[1].Left)
        Assert.Equal(240_000.0, owner[1].Right)
        Measure("raw array", () -> owner[1].Left++, Iterations)
        Measure("BCL memory", () -> owner.AsMemory(1, 32).Span[0].Left++, Iterations)
        Measure("explicit range copy", () -> owner[1 .. 33][0].Left++, Iterations)
    }

    private func Measure(name string, operation() -> void, iterations int32) {
        let timer = Stopwatch.StartNew()
        let before = GC.GetAllocatedBytesForCurrentThread()
        for var i = 0; i < iterations; i++ {
            operation()
        }
        let bytes = GC.GetAllocatedBytesForCurrentThread() - before
        timer.Stop()
        output.WriteLine("$name: $iterations operations, ${timer.Elapsed.TotalMilliseconds:F3} ms, $bytes bytes.")
    }

    private struct StereoFrame {
        var Left float64
        var Right float64
    }

    private class CustomOwner : MemoryManager[int32] {
        private let storage[]int32 = [4]int32
        override func GetSpan() Span[int32] -> storage

        override func Pin(elementIndex int32 = 0) MemoryHandle {
            throw NotSupportedException()
        }

        override func Unpin() { }

        protected override func Dispose(disposing bool) { }
    }

    shared {
        @System.Runtime.CompilerServices.MethodImpl(MethodImplOptions.NoInlining)
        private func CreateRetainedView()(View slice[int32], Owner WeakReference) {
            let owner = []int32{1, 2, 3, 4}
            return (slice[int32].FromArray(owner).Subslice(1, 1), WeakReference(owner))
        }

        private func Process(frames slice[StereoFrame], appends slice[int32]) {
            var view = frames.Subslice(1, 33)
            view[0].Left++
            view[0].Right += float64(2.0)
            let appended = appends.Append(7)
            if appended[0] != 7 {
                throw InvalidOperationException()
            }
        }
    }
}
