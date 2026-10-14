// <copyright file="ManagedReferenceRuntimeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import Gsharp.Values
import System
import System.Diagnostics
import System.Runtime.CompilerServices
import System.Threading.Tasks
import Xunit
import Xunit.Abstractions

class ManagedReferenceRuntimeTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    @Fact
    func ArraySliceAndPermissionViewsShareCanonicalLocations() {
        let array = []int32{1, 2, 3}
        let direct = managed[int32].FromArray(array, 1)
        let slice = Gsharp.Values.Slice[int32].FromArray(array).Subslice(1, 2, 2)
        let fromSlice = slice.GetManagedReference(0)
        let readOnly = slice.AsReadOnly().GetReadOnlyManagedReference(0)
        let directReadOnly = readonly managed[int32].FromArray(array, 1)
        Assert.NotSame(direct, fromSlice)
        Assert.True(direct == fromSlice)
        Assert.True(direct.SameLocation(readOnly))
        Assert.True(direct.SameLocation(directReadOnly))
        Assert.True(readOnly.Equals(directReadOnly))
        Assert.Equal(direct.GetHashCode(), readOnly.GetHashCode())
        Assert.Equal(direct.GetHashCode(), directReadOnly.GetHashCode())
        let hash = direct.GetHashCode()
        let ref readonly observed int32 = readOnly.Borrow()
        let grown = slice.Append(4)
        direct.Borrow() = 17
        Assert.Equal(17, observed)
        Assert.Equal(17, array[1])
        Assert.Equal(2, grown[0])
        Assert.Equal(hash, direct.GetHashCode())
        Assert.False(direct.SameLocation(managed[int32].FromArray(array, 0)))
        Assert.False(direct.SameLocation(managed[int32].FromArray([]int32{1, 17, 3}, 1)))
    }

    @Fact
    func ArrayLocationIdentityIsLazyCachedAndSafelyPublished() {
        const Iterations = 20_000
        let owner = []int32{7}
        WarmLocationFactories(owner)
        var checksum = 0
        var before = GC.GetAllocatedBytesForCurrentThread()
        for var i = 0; i < Iterations; i++ {
            checksum += managed[int32].FromArray(owner, 0).Borrow()
        }
        let immediateBytes = GC.GetAllocatedBytesForCurrentThread() - before
        let retained = [Iterations]managed[int32]?
        before = GC.GetAllocatedBytesForCurrentThread()
        for var i = 0; i < retained.Length; i++ {
            retained[i] = managed[int32].FromArray(owner, 0)
        }
        let retainedBytes = GC.GetAllocatedBytesForCurrentThread() - before
        let readOnly = [Iterations]readonly managed[int32]?
        before = GC.GetAllocatedBytesForCurrentThread()
        for var i = 0; i < readOnly.Length; i++ {
            readOnly[i] = readonly managed[int32].FromArray(owner, 0)
        }
        let readOnlyBytes = GC.GetAllocatedBytesForCurrentThread() - before
        let keys = [Iterations]ManagedLocationKey
        before = GC.GetAllocatedBytesForCurrentThread()
        for var i = 0; i < retained.Length; i++ {
            keys[i] = retained[i]!!.GetLocation()
        }
        let firstIdentityBytes = GC.GetAllocatedBytesForCurrentThread() - before
        before = GC.GetAllocatedBytesForCurrentThread()
        for var i = 0; i < retained.Length; i++ {
            Assert.Same(keys[i], retained[i]!!.GetLocation())
        }
        let warmedIdentityBytes = GC.GetAllocatedBytesForCurrentThread() - before
        let concurrentlyObserved = [Environment.ProcessorCount * 4]ManagedLocationKey
        Parallel.For(
            0,
            concurrentlyObserved.Length,
            (i int32) -> {
                concurrentlyObserved[i] = readOnly[0]!!.GetLocation()
            }
        )
        Assert.Equal(Iterations * 7, checksum)
        const AllocationCeiling = (int64(Iterations) * BytesPerHandle) + OneTimeRuntimeAllowanceBytes
        Assert.InRange(immediateBytes, int64(1), AllocationCeiling)
        Assert.InRange(retainedBytes, int64(1), AllocationCeiling)
        Assert.InRange(readOnlyBytes, int64(1), AllocationCeiling)
        Assert.InRange(firstIdentityBytes, int64(1), AllocationCeiling)
        Assert.Equal(int64(0), warmedIdentityBytes)
        Assert.All(concurrentlyObserved, (key ManagedLocationKey) -> Assert.Same(concurrentlyObserved[0], key))
        this.output.WriteLine(
            "iterations=$Iterations; immediate=$immediateBytes; retained=$retainedBytes; " +
                "readonly=$readOnlyBytes; first-identity=$firstIdentityBytes; warmed-identity=$warmedIdentityBytes"
        )
        GC.KeepAlive(retained)
        GC.KeepAlive(readOnly)
    }

    @Fact
    func ChecksRejectCovarianceNullAndLengthRatherThanCapacity() {
        let covariant[]object = cast[[]object]([]string{"value"})
        Assert.Throws[ArrayTypeMismatchException](
            func () object? {
                return managed[object].FromArray(covariant, 0)
            }
        )
        Assert.Throws[ArrayTypeMismatchException](
            func () object? {
                return readonly managed[object].FromArray(covariant, 0)
            }
        )
        Assert.Throws[IndexOutOfRangeException](
            func () object? {
                return managed[int32].FromArray([]int32{1}, 1)
            }
        )
        Assert.Throws[IndexOutOfRangeException](
            func () object? {
                return slice[int32].Create(1, 4).GetManagedReference(1)
            }
        )
        Assert.Throws[IndexOutOfRangeException](
            func () object? {
                return slice[int32].Create(1, 4).AsReadOnly().GetReadOnlyManagedReference(1)
            }
        )
        let nil_ managed[int32]? = nil
        Assert.True(nil_ == nil)
        Assert.False(nil_ == managed[int32].FromArray([]int32{0}, 0))
    }

    @Fact
    func OwnerSurvivesMovingCollectionsWithoutPinning() {
        let (handle, readOnlyHandle, owner, readOnlyOwner) = Retain()
        GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: true)
        GC.WaitForPendingFinalizers()
        GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: true)
        Assert.True(owner.IsAlive)
        Assert.True(readOnlyOwner.IsAlive)
        handle.Borrow() = 23
        Assert.Equal(23, handle.Borrow())
        Assert.Equal(29, readOnlyHandle.Borrow())
        GC.KeepAlive(handle)
        GC.KeepAlive(readOnlyHandle)
    }

    @Fact
    func WarmDereferencesAllocateNothingAgainstBorrowAndCellBaselines() {
        // Predeclared sanity budgets, not a portable throughput promise.
        const iterations = 1_000_000
        let budget = TimeSpan.FromSeconds(5)
        let array = []int32{0}
        let handle = managed[int32].FromArray(array, 0)
        let cell = StrongBox[int32](0)
        for var i = 0; i < 10_000; i++ {
            handle.Borrow()++
        }
        let stopwatch = Stopwatch.StartNew()
        let before = GC.GetAllocatedBytesForCurrentThread()
        for var i = 0; i < iterations; i++ {
            handle.Borrow()++
        }
        let allocated = GC.GetAllocatedBytesForCurrentThread() - before
        let handleTime = stopwatch.Elapsed
        stopwatch.Restart()
        var ref direct int32 = array[0]
        for var i = 0; i < iterations; i++ {
            direct++
        }
        let borrowTime = stopwatch.Elapsed
        stopwatch.Restart()
        for var i = 0; i < iterations; i++ {
            cell.Value++
        }
        let cellTime = stopwatch.Elapsed
        Assert.Equal(int64(0), allocated)
        Assert.Equal((iterations * 2) + 10_000, array[0])
        Assert.Equal(iterations, cell.Value)
        Assert.True(handleTime < budget, handleTime.ToString())
        this.output.WriteLine(
            "iterations=$iterations; allocations=$allocated; handle=$handleTime; borrowed=$borrowTime; StrongBox=$cellTime; budget=$budget"
        )
    }

    shared {
        /// The size of one array-location handle (`ArrayLocation`: object
        /// header, method table, owner, index and the lazily filled location-key
        /// slot). Each measured loop below may allocate at most one per iteration.
        private const BytesPerHandle int64 = 40

        /// Issue #4630: allocations the runtime makes ONCE on this thread while a
        /// measured loop runs, independent of the iteration count. A 20,000-trip loop
        /// in a Tier-0 method is promoted by on-stack replacement mid-loop, and that
        /// transition can allocate on the current thread. CI measured exactly
        /// 20,000 x 40 + 24,624 bytes twice, failing a bound that had no slack. 64 KiB
        /// is more than twice that observation, and still far below what ONE extra
        /// object per iteration costs (20,000 x 24 = 480,000 bytes), so a regression
        /// that allocates per operation still fails.
        private const OneTimeRuntimeAllowanceBytes int64 = 64 * 1024

        @MethodImpl(MethodImplOptions.NoInlining)
        private func WarmLocationFactories(owner[]int32) {
            let _ = managed[int32].FromArray(owner, 0).Borrow()
            let _ = readonly managed[int32].FromArray(owner, 0).Borrow()
            let _ = managed[int32].FromArray(owner, 0).GetLocation()
        }

        @MethodImpl(MethodImplOptions.NoInlining)
        private func Retain()(
            Handle managed[int32],
            ReadOnlyHandle readonly managed[int32],
            Owner WeakReference,
            ReadOnlyOwner WeakReference
        ) {
            let owner = []int32{7}
            let readOnlyOwner = []int32{29}
            return (
                managed[int32].FromArray(owner, 0),
                readonly managed[int32].FromArray(readOnlyOwner, 0),
                WeakReference(owner),
                WeakReference(readOnlyOwner)
            )
        }
    }
}
