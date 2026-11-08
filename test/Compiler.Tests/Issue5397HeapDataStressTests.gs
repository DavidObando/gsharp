// Copyright (C) GSharp Authors. All rights reserved.

package GSharp.Compiler.Tests

import Gsharp.Values
import System
import System.Runtime.CompilerServices
import System.Threading
import System.Threading.Tasks
import Xunit

/// Issue #5397: deterministic, bounded stress tests for heap-backed G# value
/// abstractions (`managed[T]`, `readonly managed[T]`, `slice[T]`,
/// `readonly slice[T]`, and `bytestring`) across forced GC compactions,
/// concurrent multi-threaded access, reslicing, reallocation, and lifetime
/// boundaries.
class Issue5397HeapDataStressTests {
    @Fact
    func ManagedReferences_AcrossForcedGcCompactionAndConcurrentAccess_PreserveTargetsAndIdentity() {
        const SlotCount = 64
        const WorkerCount = 4
        const IterationsPerWorker = 200
        // ADR-0154 behavioral discrimination: a broken managed-reference selector that ignores the
        // element offset (aliasing slot 0 instead of slot `i`) must fail the stress harness.
        Assert.ThrowsAny[Exception](
            () -> VerifyManagedReferenceCompactionStress(
                8,
                2,
                10,
                (s Slice[int64], _ int32) -> s.AsReadOnly().GetReadOnlyManagedReference(0)
            )
        )
        VerifyManagedReferenceCompactionStress(
            SlotCount,
            WorkerCount,
            IterationsPerWorker,
            (s Slice[int64], i int32) -> s.AsReadOnly().GetReadOnlyManagedReference(i)
        )
    }

    private func VerifyManagedReferenceCompactionStress(
        slotCount int32,
        workerCount int32,
        iterationsPerWorker int32,
        selectReadOnly(Slice[int64], int32) -> readonly managed[int64]
    ) {
        let backing = [slotCount]int64
        let mutableRefs = [slotCount]managed[int64]?
        let readOnlyRefs = [slotCount]readonly managed[int64]?
        let initialKeys = [slotCount]ManagedLocationKey
        let sliceView = Slice[int64].FromArray(backing)
        for var i = 0; i < slotCount; i++ {
            backing[i] = EncodeTaggedSlotValue(i, 0)
            mutableRefs[i] = sliceView.GetManagedReference(i)
            readOnlyRefs[i] = selectReadOnly(sliceView, i)
            initialKeys[i] = mutableRefs[i]!!.GetLocation()
            Assert.True(mutableRefs[i]!!.SameLocation(readOnlyRefs[i]!!))
        }
        RunDedicatedWorkers(
            workerCount,
            (worker int32) -> {
                for var iter = 0; iter < iterationsPerWorker; iter++ {
                    // Allocate ephemeral heap garbage so forced compactions move surrounding objects.
                    let churn = [64]uint8
                    churn[0] = uint8(iter & 0xFF)
                    GC.KeepAlive(churn)
                    if worker < 2 {
                        for var slot = worker; slot < slotCount; slot += 2 {
                            let m = mutableRefs[slot]!!
                            let nextValue = EncodeTaggedSlotValue(slot, iter + 1)
                            Volatile.Write(ref m.Borrow(), nextValue)
                        }
                    } else {
                        for var slot = 0; slot < slotCount; slot++ {
                            let m = mutableRefs[slot]!!
                            let ro = readOnlyRefs[slot]!!
                            let observed = Volatile.Read(ref Unsafe.AsRef(in ro.Borrow()))
                            Assert.True(
                                IsValidTaggedSlotValue(slot, iterationsPerWorker, observed),
                                "slot $slot observed torn or invalid value $observed"
                            )
                            Assert.Same(initialKeys[slot], m.GetLocation())
                            Assert.Equal(initialKeys[slot], ro.GetLocation())
                            Assert.True(m.SameLocation(ro))
                        }
                    }
                    if worker == 0 && (iter % 40) == 0 {
                        GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: true)
                    }
                }
            }
        )
        GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: true)
        for var i = 0; i < slotCount; i++ {
            let expected = EncodeTaggedSlotValue(i, iterationsPerWorker)
            Assert.Equal(expected, backing[i])
            Assert.Equal(expected, mutableRefs[i]!!.Borrow())
            Assert.Equal(expected, readOnlyRefs[i]!!.Borrow())
            Assert.Same(initialKeys[i], mutableRefs[i]!!.GetLocation())
        }
    }

    @Fact
    func SlicesAndReadOnlySlices_AcrossCompactionReslicingAndReallocation_IsolateViewsAndPreserveElements() {
        const ElementCount = 48
        const SharedWindowLength = 24
        const PublishedVersions = 6
        let initialNodes = [ElementCount]StressNode
        for var i = 0; i < ElementCount; i++ {
            initialNodes[i] = StressNode(i, "node-$i-v0")
        }
        let publishedPool = [SharedWindowLength, PublishedVersions]StressNode
        for var idx = 0; idx < SharedWindowLength; idx++ {
            let id = 12 + idx
            publishedPool[idx, 0] = initialNodes[id]
            for var v = 1; v < PublishedVersions; v++ {
                publishedPool[idx, v] = StressNode(id, "node-$id-v$v")
            }
        }
        let baseSlice = Slice[StressNode].FromArray(initialNodes)
        let window = baseSlice.Subslice(8, 40, 40)
        let readOnlyWindow = window.AsReadOnly().Subslice(4, 28)
        let pinnedRef = window.GetManagedReference(4)
        let readOnlyRef = readOnlyWindow.GetReadOnlyManagedReference(0)
        Assert.True(pinnedRef.SameLocation(readOnlyRef))
        // Capacity-limited append must allocate a new backing array while leaving
        // `window`, `readOnlyWindow`, `pinnedRef`, and `readOnlyRef` attached to `initialNodes`.
        var reallocated = window.Subslice(0, 16, 16).Append(StressNode(999, "appended"))
        reallocated[0] = StressNode(-1, "reallocated-head")
        Assert.Equal("node-8-v0", window[0].Label)
        RunDedicatedWorkers(
            4,
            (worker int32) -> {
                for var step = 0; step < 150; step++ {
                    let temp = [128]int32
                    temp[0] = step
                    GC.KeepAlive(temp)
                    if worker < 2 {
                        for var idx = worker; idx < SharedWindowLength; idx += 2 {
                            let version = (step + 1) % PublishedVersions
                            let candidate = publishedPool[idx, version]
                            let slotRef = window.GetManagedReference(4 + idx)
                            Volatile.Write(ref slotRef.Borrow(), candidate)
                        }
                    } else {
                        for var idx = 0; idx < SharedWindowLength; idx++ {
                            let sub = readOnlyWindow.Subslice(idx, idx + 1)
                            let node = Volatile.Read(ref Unsafe.AsRef(in sub.GetReadOnlyManagedReference(0).Borrow()))
                            Assert.NotNull(node)
                            Assert.Equal(12 + idx, node.Id)
                            Assert.True(
                                IsPublishedNode(publishedPool, idx, PublishedVersions, node),
                                "observed unpublished or corrupted StressNode at index $idx"
                            )
                        }
                    }
                    if worker == 0 && (step % 30) == 0 {
                        GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: true)
                    }
                }
            }
        )
        let replacement = StressNode(777, "replaced-after-gc")
        pinnedRef.Borrow() = replacement
        GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: true)
        Assert.Same(replacement, readOnlyRef.Borrow())
        Assert.Same(replacement, readOnlyWindow[0])
        Assert.Same(replacement, initialNodes[12])
        Assert.Equal("node-12-v0", reallocated[4].Label)
        Assert.Equal("appended", reallocated[16].Label)
    }

    @Fact
    func LifetimeBoundaries_UnreferencedSliceOwnersCollectWhileSubsliceRetainsOwner() {
        // ADR-0154 behavioral discrimination: losing the retained backing owner must fail the
        // lifetime-boundary assertion after GC compaction.
        Assert.ThrowsAny[Exception](() -> VerifyLifetimeBoundaries(retainOwner: false))
        VerifyLifetimeBoundaries(retainOwner: true)
    }

    private func VerifyLifetimeBoundaries(retainOwner bool) {
        let (
            retainedSubslice,
            retainedRef,
            sliceAliveOwner,
            refAliveOwner,
            deadSliceOwner,
            deadRefOwner
        ) = CreateLifetimeBoundaryProbes(retainOwner)
        for var round = 0; round < 4; round++ {
            let pressure = [1024]uint8
            pressure[0] = uint8(round)
            GC.KeepAlive(pressure)
            GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: true)
            GC.WaitForPendingFinalizers()
        }
        Assert.True(sliceAliveOwner.IsAlive)
        Assert.True(refAliveOwner.IsAlive)
        Assert.False(deadSliceOwner.IsAlive)
        Assert.False(deadRefOwner.IsAlive)
        Assert.Equal(42, retainedSubslice[0])
        Assert.Equal(84, retainedRef.Borrow())
        GC.KeepAlive(retainedSubslice)
        GC.KeepAlive(retainedRef)
    }

    @Fact
    func ByteStrings_AcrossCompactionSlicingConcatAndConcurrentDecoding_RemainImmutable() {
        let rawBytes = []uint8{0xFF, 0x41, 0x42, 0x43, 0xC3, 0xA9, 0xF0, 0x9F, 0x98, 0x80, 0x31, 0x32, 0x33, 0xFE}
        let sourceSlice = Slice[uint8].FromArray(rawBytes)
        let trimmed = ByteString.CopyFrom(sourceSlice.Subslice(1, 13).AsReadOnly())
        // Mutating the source array/slice after construction must not affect the ByteString.
        for var i = 0; i < rawBytes.Length; i++ {
            rawBytes[i] = 0
        }
        let prefix = trimmed.Subslice(0, 5).Detach()
        let suffix = trimmed.Subslice(5, trimmed.Length).Detach()
        let rebuilt = prefix.Concat(suffix)
        let expectedCodePoints = []int32{0x41, 0x42, 0x43, 0xE9, 0x1F600, 0x31, 0x32, 0x33}
        let expectedHash = trimmed.GetHashCode()
        Parallel.For(
            0,
            4,
            (worker int32) -> {
                for var iter = 0; iter < 150; iter++ {
                    let scratch = ByteString.FromCodePoints(
                        ReadOnlySlice[int32].FromArray([]int32{65 + (worker % 26), 48 + (iter % 10)}),
                        CodePointEncoding.Strict
                    )
                    Assert.Equal(2, scratch.Length)
                    Assert.Equal(trimmed, rebuilt)
                    Assert.Equal(expectedHash, rebuilt.GetHashCode())
                    let decoded = rebuilt.DecodeCodePoints(Utf8Decoding.Strict)
                    Assert.Equal(expectedCodePoints, decoded.ToArray())
                    if worker == 0 && (iter % 35) == 0 {
                        GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: true)
                    }
                }
            }
        )
        GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: true)
        Assert.Equal(expectedCodePoints, rebuilt.DecodeCodePoints(Utf8Decoding.Strict).ToArray())
    }

    @Fact
    func CompiledGSharpHeapAbstractions_UnderCompactionAndConcurrency_VerifyAndRunCleanly() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let assembly = fixture.Compile(`package HeapStress
import System
import System.Threading
import System.Threading.Tasks
import Gsharp.Values

class BoxedItem {
    prop Id int32
    prop Tag string
    init(id int32, tag string) {
        Id = id
        Tag = tag
    }
}

func Main() {
    var items = slice[BoxedItem]{
        BoxedItem(10, "a"),
        BoxedItem(20, "b"),
        BoxedItem(30, "c"),
        BoxedItem(40, "d")
    }
    let window = items.Subslice(1, 3, 3)
    let roWindow readonly slice[BoxedItem] = window
    let m managed[BoxedItem] = managed(window[0])
    let ro readonly managed[BoxedItem] = readonly managed(window[0])
    var detached = window.Append(BoxedItem(50, "e"))
    detached[0] = BoxedItem(99, "detached")

    var counters = []int32{1, 2, 3, 4, 5, 6, 7, 8}
    let counterSlice = Slice[int32].FromArray(counters)[2..6]
    let counterRef managed[int32] = managed(counterSlice[1])
    let counterReadOnly readonly managed[int32] = readonly managed(counterSlice[1])

    let text bytestring = b"prefix:hello-gsharp-heap:suffix"[7..24]
    let candidateA = items[1]
    let candidateB = BoxedItem(77, "updated")
    using let barrier = Barrier(4)
    var threads = [4]Thread
    var failures = [4]Exception?
    for var workerIndex = 0; workerIndex < 4; workerIndex++ {
        let w = workerIndex
        threads[w] = Thread(ThreadStart(() -> {
            try {
                if !barrier.SignalAndWait(TimeSpan.FromSeconds(30)) {
                    throw TimeoutException("barrier timed out")
                }
                for var i = 0; i < 120; i++ {
                    let sub = text[6..12]
                    if sub != b"gsharp" {
                        throw InvalidOperationException("bytestring slice mismatch")
                    }
                    if w == 0 {
                        *m = if (i % 2) == 0 { candidateB } else { candidateA }
                        *counterRef = if (i % 2) == 0 { 444 } else { 222 }
                        if (i % 25) == 0 {
                            GC.Collect(2, GCCollectionMode.Forced, true, true)
                        }
                    } else {
                        let currentItem = *ro
                        if !object.ReferenceEquals(currentItem, candidateA) && !object.ReferenceEquals(currentItem, candidateB) {
                            throw InvalidOperationException("unexpected item identity")
                        }
                        if (currentItem.Id != 20 || currentItem.Tag != "b") &&
                            (currentItem.Id != 77 || currentItem.Tag != "updated") {
                            throw InvalidOperationException("unexpected item state")
                        }
                        let currentCounter = *counterReadOnly
                        if currentCounter != 4 && currentCounter != 222 && currentCounter != 444 {
                            throw InvalidOperationException("unexpected counter value")
                        }
                    }
                }
            } catch (ex Exception) {
                failures[w] = ex
            }
        })){IsBackground = true}
        threads[w].Start()
    }
    for var workerIndex = 0; workerIndex < 4; workerIndex++ {
        if !threads[workerIndex].Join(TimeSpan.FromSeconds(30)) {
            throw TimeoutException("worker join timed out")
        }
    }
    for var workerIndex = 0; workerIndex < 4; workerIndex++ {
        if failures[workerIndex] is {} ex {
            throw ex
        }
    }

    *m = candidateB
    *counterRef = 444
    GC.Collect(2, GCCollectionMode.Forced, true, true)

    Console.WriteLine((*ro).Id)
    Console.WriteLine(items[1].Tag)
    Console.WriteLine(detached[0].Tag)
    Console.WriteLine(detached[2].Id)
    Console.WriteLine(*counterReadOnly)
    Console.WriteLine(counters[3])
    Console.WriteLine(text == b"hello-gsharp-heap")
}
`, "heap-stress", true)
        IlVerifier.Verify(assembly)
        Assert.Equal("77\nupdated\ndetached\n50\n444\n444\nTrue\n", fixture.Run(assembly))
    }

    shared {
        private func RunDedicatedWorkers(workerCount int32, body(int32) -> void) {
            using let barrier = Barrier(workerCount)
            let threads = [workerCount]Thread
            let failures = [workerCount]Exception?
            for var w = 0; w < workerCount; w++ {
                let worker = w
                threads[w] = Thread(
                    ThreadStart(
                        () -> {
                            try {
                                if !barrier.SignalAndWait(TimeSpan.FromSeconds(30)) {
                                    throw TimeoutException("Timed out waiting for stress worker barrier.")
                                }
                                body(worker)
                            } catch (ex Exception) {
                                failures[worker] = ex
                            }
                        }
                    )
                ){IsBackground = true}
                threads[w].Start()
            }
            for var w = 0; w < workerCount; w++ {
                Assert.True(threads[w].Join(TimeSpan.FromSeconds(30)), "Stress worker $w timed out.")
            }
            for var w = 0; w < workerCount; w++ {
                if failures[w] is {} ex {
                    throw InvalidOperationException("Stress worker $w failed: ${ex.Message}", ex)
                }
            }
        }

        private func EncodeTaggedSlotValue(slot int32, iteration int32) int64 {
            let payload = uint32(((slot + 1) << 20) | (iteration & 0xFFFFF))
            let high = uint64(payload ^ 0xA5A55A5Au) << 32
            let low = uint64(payload ^ 0x5A5AA5A5u)
            return int64(high | low)
        }

        private func IsValidTaggedSlotValue(slot int32, maxIteration int32, observed int64) bool {
            let bits = uint64(observed)
            let highPayload = uint32(bits >> 32) ^ 0xA5A55A5Au
            let lowPayload = uint32(bits) ^ 0x5A5AA5A5u
            if highPayload != lowPayload {
                return false
            }
            let observedSlot = int32(highPayload >> 20)
            let iteration = int32(highPayload & 0xFFFFFu)
            return observedSlot == slot + 1 && iteration >= 0 && iteration <= maxIteration
        }

        private func IsPublishedNode(pool[,]StressNode, slot int32, versionCount int32, observed StressNode) bool {
            for var v = 0; v < versionCount; v++ {
                let candidate = pool[slot, v]
                if object.ReferenceEquals(candidate, observed) {
                    return observed.Label == "node-${12 + slot}-v$v"
                }
            }
            return false
        }

        @MethodImpl(MethodImplOptions.NoInlining)
        private func CreateLifetimeBoundaryProbes(retainOwner bool)(
            RetainedSlice ReadOnlySlice[int32],
            RetainedRef readonly managed[int32],
            SliceAliveOwner WeakReference,
            RefAliveOwner WeakReference,
            DeadSliceOwner WeakReference,
            DeadRefOwner WeakReference
        ) {
            let sliceRetainedBacking = []int32{10, 42, 99}
            let refRetainedBacking = []int32{7, 84, 100}
            let transientSliceBacking = []int32{1, 2, 3, 4}
            let transientRefBacking = []int32{5, 6, 7, 8}
            let retainedSlice = if retainOwner {
                Slice[int32].FromArray(sliceRetainedBacking).Subslice(1, 2).AsReadOnly()
            } else {
                Slice[int32].FromArray([]int32{42}).AsReadOnly()
            }
            let retainedRef = if retainOwner {
                Slice[int32].FromArray(refRetainedBacking).Subslice(1, 2).AsReadOnly().GetReadOnlyManagedReference(0)
            } else {
                Slice[int32].FromArray([]int32{84}).AsReadOnly().GetReadOnlyManagedReference(0)
            }
            let transientSlice = Slice[int32].FromArray(transientSliceBacking).Subslice(0, 2)
            let transientRef = Slice[int32].FromArray(transientRefBacking).GetReadOnlyManagedReference(0)
            Assert.Equal(1, transientSlice[0])
            Assert.Equal(5, transientRef.Borrow())
            return (
                retainedSlice,
                retainedRef,
                WeakReference(sliceRetainedBacking),
                WeakReference(refRetainedBacking),
                WeakReference(transientSliceBacking),
                WeakReference(transientRefBacking)
            )
        }
    }
}

internal sealed class StressNode {
    prop Id int32 {
        get;
    }

    prop Label string {
        get;
    }

    init(id int32, label string) {
        Id = id
        Label = label
    }
}
