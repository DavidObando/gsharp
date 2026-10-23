// <copyright file="Issue5137EmitPoolingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Concurrent
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import System.Threading
import System.Threading.Tasks
import Xunit

/// Issue #5137 — the max-stack scan reads the IL builder in place, and the
/// per-body emit session and planner collectors are reused across bodies.
/// Output bytes must not change, and a reused collection must never carry
/// state from one body (or one thread) to the next.
class Issue5137EmitPoolingTests {
    // ---- max stack: the chunked scan equals the array scan ----

    @Fact
    func MaxStack_ChunkedScanEqualsArrayScanAtEverySplitPoint() {
        let streams = SampleStreams()
        Assert.True(streams.Count >= 9)
        for stream in streams {
            let expected = Outcome(() -> MaxStackTracker.ComputeMaxStack(stream))
            for var split = 0; split <= stream.Length; split++ {
                let chunked = Chunked(stream, split)
                Assert.Equal(expected, Outcome(() -> MaxStackTracker.ComputeMaxStack(chunked)))
            }
        }
    }

    @Fact
    func MaxStack_OneByteChunksAndThreeWaySplitsEqualArrayScan() {
        for stream in SampleStreams().Where((s[]uint8) -> s.Length <= 48) {
            let expected = Outcome(() -> MaxStackTracker.ComputeMaxStack(stream))
            let singles = BlobBuilder()
            for value in stream {
                let one = BlobBuilder()
                one.WriteByte(value)
                singles.LinkSuffix(one)
            }
            Assert.Equal(expected, Outcome(() -> MaxStackTracker.ComputeMaxStack(singles)))
            for var first = 0; first <= stream.Length; first++ {
                for var second = first; second <= stream.Length; second++ {
                    let parts = BlobBuilder()
                    parts.WriteBytes(stream, 0, first)
                    let middle = BlobBuilder()
                    middle.WriteBytes(stream, first, second - first)
                    let last = BlobBuilder()
                    last.WriteBytes(stream, second, stream.Length - second)
                    parts.LinkSuffix(middle)
                    parts.LinkSuffix(last)
                    Assert.Equal(expected, Outcome(() -> MaxStackTracker.ComputeMaxStack(parts)))
                }
            }
        }
    }

    @Fact
    func MaxStack_RandomBytesIncludingTruncatedAndUnknownOpcodesMatchTheArrayScan() {
        let random = Random(5137)
        var compared = 0
        for var round = 0; round < 300; round++ {
            let stream = GC.AllocateArray[uint8](random.Next(0, 64))
            random.NextBytes(stream)
            let expected = Outcome(() -> MaxStackTracker.ComputeMaxStack(stream))
            for var split = 0; split <= stream.Length; split += 3 {
                let chunked = Chunked(stream, split)
                Assert.Equal(expected, Outcome(() -> MaxStackTracker.ComputeMaxStack(chunked)))
                compared++
            }
        }
        Assert.True(compared > 1000)
    }

    @Fact
    func MaxStack_ScanDoesNotCopyTheInstructionStream() {
        let big = BlobBuilder()
        for var i = 0; i < 20000; i++ {
            big.WriteByte(uint8(0x17)) // ldc.i4.1
            big.WriteByte(uint8(0x26)) // pop

        }
        let il = InstructionEncoder(big)
        let _ = MaxStackTracker.ComputeMaxStack(il)
        let before = GC.GetAllocatedBytesForCurrentThread()
        let value = MaxStackTracker.ComputeMaxStack(il)
        let allocated = GC.GetAllocatedBytesForCurrentThread() - before
        Assert.Equal(20000, value)
        // The old path allocated a copy of all 40000 bytes.
        Assert.True(allocated < 4096L, "allocated $allocated bytes")
    }

    @Fact
    func MaxStack_EveryEmittedBodyDeclaresTheArrayScanValue() {
        let (bytes, counters) = EmitBytes(RichSource(), 1)
        using let pe = PEReader(ImmutableArray.Create(bytes))
        let md = pe.GetMetadataReader()
        var fat = 0
        var wide = 0
        var bodies = 0
        for handle in md.MethodDefinitions {
            let method = md.GetMethodDefinition(handle)
            if method.RelativeVirtualAddress == 0 {
                continue
            }
            let body = pe.GetMethodBody(method.RelativeVirtualAddress)
            let expected = MaxStackTracker.ComputeMaxStack(body.GetILBytes())
            bodies++
            if expected <= 8 {
                // Tiny or fat: a fat header carries the exact value, a tiny one implies 8.
                Assert.True(body.MaxStack == expected || body.MaxStack == 8, md.GetString(method.Name))
            } else {
                Assert.Equal(expected, body.MaxStack)
                wide++
            }
            if body.MaxStack == expected {
                fat++
            }
        }
        Assert.True(bodies > 20)
        Assert.True(fat > 5)
        Assert.True(wide > 0, "no body needs more than eight slots")
        Assert.True(counters.StreamedScans >= bodies - 8)
    }

    // ---- pooled collections are cleared and race-safe ----

    @Fact
    func SessionScratch_ComesBackEmptyAfterRelease() {
        let pool = NewPool()
        let first = pool.Rent()
        Fill(first.Item)
        Assert.True(first.Item.HeldCount > 0)
        first.Release()
        let second = pool.Rent()
        Assert.Same(first.Item, second.Item)
        Assert.Equal(0, second.Item.HeldCount)
        Assert.Empty(second.Item.Locals)
        Assert.Empty(second.Item.Labels)
        Assert.Empty(second.Item.LocalTypes)
        Assert.Empty(second.Item.GetPlanner().ReceiverSpills)
        Assert.Empty(second.Item.GetPlanner().StackAllocs)
        Assert.Equal(1, second.Item.GetPlanner().Clears)
    }

    @Fact
    func ScratchPool_ReleasingTheSameLeaseTwiceFreesTheItemOnce() {
        let pool = NewPool()
        let lease = pool.Rent()
        lease.Release()
        lease.Release()
        Assert.Equal(1, pool.GetFreeCount())
        let a = pool.Rent()
        let b = pool.Rent()
        Assert.NotSame(a.Item, b.Item)
    }

    @Fact
    func ScratchPool_AStaleSecondReleaseCannotClearOrFreeAnItemThatWasRentedAgain() {
        // The interleaving of the review: lease A is released, B rents the same item and
        // fills it, and then A is released again. B must keep its data and keep the item.
        let pool = NewPool()
        let a = pool.Rent()
        a.Release()
        let b = pool.Rent()
        Assert.Same(a.Item, b.Item)
        Fill(b.Item)
        a.Release()
        Assert.True(b.Item.HeldCount > 0, "the stale release cleared a borrowed item")
        Assert.Equal(0, pool.GetFreeCount())
        let c = pool.Rent()
        Assert.NotSame(b.Item, c.Item)
        b.Release()
        Assert.Equal(1, pool.GetFreeCount())
    }

    @Fact
    func ScratchPool_DropsAScratchThatGrewTooLarge() {
        let pool = NewPool()
        let big = pool.Rent()
        for var i = 0; i < SessionScratch.MaxRetainedEntries + 1; i++ {
            big.Item.LocalTypes.Add(TypeSymbol.Int32)
        }
        big.Release()
        Assert.Equal(0, pool.GetFreeCount())
        // The dropped item was still cleared, so a stale reference sees nothing.
        Assert.Equal(0, big.Item.HeldCount)
        Assert.NotSame(big.Item, pool.Rent().Item)
    }

    @Fact
    func ScratchPool_DropsAScratchWhoseCollectorGrewInAnEarlierRegionAndWasClearedLater() {
        // A constructor plans several regions with one scratch. A collector that grew in an
        // earlier region keeps its storage after the next region clears it, so the number of
        // live entries is zero while the scratch still holds a large array.
        let pool = NewPool()
        let lease = pool.Rent()
        let planner = lease.Item.GetPlanner()
        for var i = 0; i < SessionScratch.MaxRetainedEntries + 1; i++ {
            planner.ReceiverSpills.Add(BoundLiteralExpression(nil, 1))
        }
        planner.ReceiverSpills.Clear()
        Assert.Equal(0, lease.Item.HeldCount)
        lease.Release()
        Assert.Equal(0, pool.GetFreeCount())
    }

    @Fact
    func ScratchPool_DropsAScratchWhoseDictionaryGrewAndWasClearedBeforeRelease() {
        let pool = NewPool()
        let lease = pool.Rent()
        for var i = 0; i < SessionScratch.MaxRetainedEntries + 1; i++ {
            lease.Item.Locals[LocalVariableSymbol("v$i", false, TypeSymbol.Int32)] = i
        }
        lease.Item.Locals.Clear()
        Assert.Equal(0, lease.Item.HeldCount)
        lease.Release()
        Assert.Equal(0, pool.GetFreeCount())
    }

    @Fact
    func ScratchPool_NeverSharesAnItemBetweenThreadsAndAlwaysHandsOutEmptyOnes() {
        let pool = NewPool()
        let inUse = ConcurrentDictionary[SessionScratch, int32]()
        var failures = 0
        let workers = 8
        let tasks = Enumerable
            .Range(0, workers)
            .Select(
            (worker int32) ->
            Task.Run(
                () -> {
                    for var i = 0; i < 2000; i++ {
                        let lease = pool.Rent()
                        if lease.Item.HeldCount != 0 {
                            Interlocked.Increment(&failures)
                        }
                        if !inUse.TryAdd(lease.Item, worker) {
                            Interlocked.Increment(&failures)
                        }
                        Fill(lease.Item)
                        if i % 7 == 0 {
                            Thread.Yield()
                        }
                        inUse.TryRemove(lease.Item, out var _)
                        lease.Release()
                    }
                }
            )
        )
            .ToArray()
        Task.WaitAll(tasks)
        Assert.Equal(0, failures)
        Assert.True(pool.GetFreeCount() >= 1)
    }

    @Fact
    func ScratchPool_RandomizedContractHoldsAcrossThreadsWithDuplicateAndOversizedReleases() {
        // Each thread rents, checks the item is empty and not held by anyone else, fills it
        // (sometimes far past the retention limit), and releases it once, twice, or twice with
        // another thread's rent in between. A borrowed item must never be cleared or shared.
        let pool = NewPool()
        let owners = ConcurrentDictionary[SessionScratch, int32]()
        var failures = 0
        var rents = 0
        let tasks = Enumerable
            .Range(0, 8)
            .Select(
            (worker int32) ->
            Task.Run(
                () -> {
                    let random = Random(5137 + worker)
                    let stale = List[ScratchLease[SessionScratch]]()
                    for var i = 0; i < 3000; i++ {
                        let lease = pool.Rent()
                        Interlocked.Increment(&rents)
                        let item = lease.Item
                        if item.HeldCount != 0 || !owners.TryAdd(item, worker) {
                            Interlocked.Increment(&failures)
                        }
                        Fill(item)
                        let sentinel = item.HeldCount
                        if random.Next(20) == 0 {
                            for var k = 0; k < SessionScratch.MaxRetainedEntries + 1; k++ {
                                item.LocalTypes.Add(TypeSymbol.Int32)
                            }
                        }
                        // Replay an old, already released lease while this item is borrowed.
                        if stale.Count > 0 && random.Next(3) == 0 {
                            stale[random.Next(stale.Count)].Release()
                            if item.HeldCount < sentinel {
                                Interlocked.Increment(&failures)
                            }
                        }
                        owners.TryRemove(item, out var _)
                        lease.Release()
                        if random.Next(2) == 0 {
                            lease.Release()
                        }
                        if stale.Count < 16 {
                            stale.Add(lease)
                        }
                    }
                }
            )
        )
            .ToArray()
        Task.WaitAll(tasks)
        Assert.Equal(0, failures)
        Assert.Equal(24000, rents)
        Assert.True(pool.GetFreeCount() <= 8)
    }

    // ---- emit: reuse happens, and output does not change ----

    @Fact
    func Emit_ReusesTheSessionAndPlannerCollectorsAcrossBodies() {
        let (bytes, counters) = EmitBytes(PlainSource(), 1)
        Assert.NotEmpty(bytes)
        Assert.True(counters.SessionReused >= 4, "reused ${counters.SessionReused}, created ${counters.SessionCreated}")
        Assert.True(counters.SessionCreated >= 1)
        Assert.True(counters.SessionCreated <= 3, "created ${counters.SessionCreated}")
        Assert.True(counters.PlannerReused >= 4, "planner reused ${counters.PlannerReused}")
    }

    @Fact
    func Emit_BodiesInOneCompilationEqualTheSameBodiesEmittedAlone() {
        // F1..F5 are emitted one after another through reused collections. Each one
        // alone sees fresh collections. They use no tokens, so the bytes are comparable.
        let names = []string{"Sum", "Affine", "Branchy", "Empty", "Larger"}
        let sources = []string{SumSource(), AffineSource(), BranchySource(), EmptySource(), LargerSource()}
        let (combined, counters) = EmitBytes("package Pooling\n" + string.Concat(sources), 1)
        Assert.True(counters.SessionReused >= 4, "reused ${counters.SessionReused}")
        let together = ReadBodies(combined)
        for var i = 0; i < names.Length; i++ {
            let (aloneImage, _) = EmitBytes("package Pooling\n" + sources[i], 1)
            let alone = ReadBodies(aloneImage)
            Assert.True(alone.ContainsKey(names[i]), names[i])
            Assert.True(together.ContainsKey(names[i]), names[i])
            let aloneBody = alone[names[i]]
            let togetherBody = together[names[i]]
            Assert.Equal(aloneBody.Il, togetherBody.Il)
            Assert.Equal(aloneBody.Locals, togetherBody.Locals)
            Assert.Equal(aloneBody.MaxStack, togetherBody.MaxStack)
        }
        // The body with no locals must not inherit the locals of the bodies before it.
        Assert.Empty(together["Empty"].Locals)
    }

    @Fact
    func Emit_OutputBytesAreIdenticalAcrossRepeatedAndParallelEmits() {
        var expected[]uint8 = Array.Empty[uint8]()
        for workers in[]int32{1, 1, 4, 2, 1} {
            let (bytes, _) = EmitBytes(RichSource(), workers)
            if expected.Length == 0 {
                expected = bytes
            } else {
                Assert.Equal(expected, bytes)
            }
        }
    }

    @Fact
    func Planner_ClearEmptiesEveryCollectorAndCountsTheReuse() {
        let scratch = SessionScratch()
        let planner = scratch.GetPlanner()
        Assert.Equal(0, planner.Clears)
        planner.ReceiverSpills.Add(BoundLiteralExpression(nil, 1))
        planner.AssignmentValueSpills.Add(BoundLiteralExpression(nil, 2))
        Assert.Equal(2, planner.HeldCount)
        Assert.True(scratch.Reset())
        Assert.Equal(1, planner.Clears)
        Assert.Equal(0, planner.HeldCount)
        Assert.Empty(planner.ReceiverSpills)
        Assert.Empty(planner.AssignmentValueSpills)
    }

    private data struct Body(Il[]uint8, Locals[]uint8, MaxStack int32)

    private data struct Counters(SessionCreated int64, SessionReused int64, PlannerReused int64, StreamedScans int64)

    shared {
        private func NewPool() ScratchPool[SessionScratch] -> ScratchPool[SessionScratch](
            "test.scratch",
            () -> SessionScratch(),
            (s SessionScratch) -> s.Reset()
        )

        private func Fill(scratch SessionScratch) {
            scratch.LocalTypes.Add(TypeSymbol.Int32)
            scratch.Locals[LocalVariableSymbol("x", false, TypeSymbol.Int32)] = 0
            scratch.Labels[BoundLabel("l")] = default(System.Reflection.Metadata.Ecma335.LabelHandle)
            scratch.GetPlanner().ReceiverSpills.Add(BoundLiteralExpression(nil, 1))
        }

        private func Outcome(compute() -> int32) string {
            try {
                return "value " + compute().ToString()
            } catch (ex Exception) {
                return "throws " + ex.GetType().Name
            }
        }

        private func Chunked(stream[]uint8, split int32) BlobBuilder {
            let first = BlobBuilder()
            first.WriteBytes(stream, 0, split)
            let second = BlobBuilder()
            second.WriteBytes(stream, split, stream.Length - split)
            first.LinkSuffix(second)
            return first
        }

        private func EmitBytes(source string, workers int32)(Image[]uint8, Counters Counters) {
            let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source, "pooling.gs"))){
                DebugInformation = DebugInformationOptions{
                    Format: DebugInformationFormat.Portable,
                    Deterministic: true,
                    PdbFilePath: "pooling.pdb"
                }
            }
            compilation.WorkBudget = CompilationWorkBudget(workers)
            using let measurement = CompilationMeasurements.Start("issue5137")
            using let pe = MemoryStream()
            using let pdb = MemoryStream()
            using let refPe = MemoryStream()
            let result = compilation.Emit(pe, pdb, refPe, docStream: nil, assemblyName: "Pooling")
            Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select((d Diagnostic) -> d.ToString())))
            let counters = Counters(
                measurement.GetCounter("emit.session-scratch.created"),
                measurement.GetCounter("emit.session-scratch.reused"),
                measurement.GetCounter("emit.planner-scratch.reused"),
                measurement.GetCounter("emit.maxstack.streamed")
            )
            return (pe.ToArray(), counters)
        }

        private func ReadBodies(image[]uint8) Dictionary[string, Body] {
            let result = Dictionary[string, Body]()
            using let pe = PEReader(ImmutableArray.Create(image))
            let md = pe.GetMetadataReader()
            for handle in md.MethodDefinitions {
                let method = md.GetMethodDefinition(handle)
                if method.RelativeVirtualAddress == 0 {
                    continue
                }
                let body = pe.GetMethodBody(method.RelativeVirtualAddress)
                var locals = Array.Empty[uint8]()
                if !body.LocalSignature.IsNil {
                    locals = md.GetBlobBytes(md.GetStandaloneSignature(body.LocalSignature).Signature)
                }
                result[md.GetString(method.Name)] = Body(body.GetILBytes()!!, locals, body.MaxStack)
            }
            return result
        }

        private func SumSource() string -> `
func Sum(x int32) int32 {
    var total = 0
    for var i = 0; i < x; i++ { total += i }
    return total
}
`

        private func AffineSource() string -> `
func Affine(x int32) int32 {
    let a = x + 1
    let b = a * 2
    let c = b - a
    return c
}
`

        private func BranchySource() string -> `
func Branchy(x int32) int32 {
    if x > 1 {
        let t = x * 3
        return t
    }
    return 0
}
`

        private func EmptySource() string -> `
func Empty() int32 { return 7 }
`

        private func LargerSource() string -> `
func Larger(x int32, y int32) int32 {
    var m = x
    if y > m { m = y }
    var n = 0
    while n < m { n += 2 }
    return n + m
}
`

        private func PlainSource() string -> "package Pooling\nimport System\n" + string.Concat(
            Enumerable.Range(0, 12).Select(
                (
                    index int32
                ) -> "func P$index(x int32) int32 {\nvar t = x\nConsole.WriteLine(t)\nreturn t + $index\n}\n"
            )
        )

        private func RichSource() string -> `package Pooling
import System
import System.Collections.Generic
import System.Threading.Tasks
func Sum10(a int32, b int32, c int32, d int32, e int32, f int32, g int32, h int32, i int32, j int32) int32 -> a + b + c + d + e + f + g + h + i + j
func Wide() int32 -> Sum10(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)
func Pick(x int32) string -> switch x {
    case 1: "one"
    case 2: "two"
    case 3: "three"
    default: "many"
}
func Guarded(x int32) int32 {
    try {
        if x > 3 { throw InvalidOperationException("big") }
        return x
    } catch (ex InvalidOperationException) {
        return -1
    } finally {
        Console.WriteLine("done")
    }
}
func Identity[T](value T) T -> value
func LongLoop(n int32) int32 {
    var total = 0
    for var i = 0; i < n; i++ {
` + string.Concat(Enumerable.Range(0, 60).Select((k int32) -> "        total += i * $k + 1\n")) + `
    }
    return total
}
class State {
    var Value int32 = (func() int32 { return 3 })()
    init() { Value += 1 }
    func Read() int32 -> Value
}
func Values() sequence[int32] {
    try { yield 2 } finally { let final = 3 }
}
async func Answer() int32 {
    await Task.Yield()
    return 6
}
func Run() int32 {
    var captured = 1
    let next = func() int32 {
        captured += 1
        return captured
    }
    var total = 0
    for value in Values() { total += value }
    return State().Read() + Identity(5) + next() + total + Wide() + Answer().GetAwaiter().GetResult() + LongLoop(3)
}
`

        private func Raw(values[]int32)[]uint8 {
            let result = GC.AllocateArray[uint8](values.Length)
            for var i = 0; i < values.Length; i++ {
                result[i] = uint8(values[i])
            }
            return result
        }

        private func SampleStreams() List[[]uint8] {
            let list = List[[]uint8]()
            // ldc.i4 7; ldc.i4.s 3; add; dup; pop; pop; ret
            list.Add(Raw([]int32{0x20, 7, 0, 0, 0, 0x1F, 3, 0x58, 0x25, 0x26, 0x26, 0x2A}))
            // call; callvirt; newobj; calli; tail. callvirt; ret
            list.Add(
                Raw(
                    []int32{
                        0x28,
                        1,
                        0,
                        0,
                        6,
                        0x6F,
                        2,
                        0,
                        0,
                        10,
                        0x73,
                        3,
                        0,
                        0,
                        10,
                        0x29,
                        4,
                        0,
                        0,
                        17,
                        0xFE,
                        0x14,
                        0x6F,
                        5,
                        0,
                        0,
                        10,
                        0x2A
                    }
                )
            )
            // switch with three targets; br; ret
            list.Add(Raw([]int32{0x45, 3, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 8, 0, 0, 0, 0x38, 0, 0, 0, 0, 0x2A}))
            // switch with zero targets; nop
            list.Add(Raw([]int32{0x45, 0, 0, 0, 0, 0, 0x2A}))
            // try: leave; finally: endfinally; two-byte opcodes ceq, ldarg 2-byte, initobj, constrained, ldftn, sizeof
            list.Add(
                Raw(
                    []int32{
                        0xDD,
                        0,
                        0,
                        0,
                        0,
                        0xDC,
                        0xFE,
                        0x01,
                        0xFE,
                        0x09,
                        2,
                        0,
                        0xFE,
                        0x15,
                        9,
                        0,
                        0,
                        1,
                        0xFE,
                        0x16,
                        9,
                        0,
                        0,
                        1,
                        0xFE,
                        0x06,
                        1,
                        0,
                        0,
                        6,
                        0xFE,
                        0x1C,
                        9,
                        0,
                        0,
                        1,
                        0x2A
                    }
                )
            )
            // ldc.i8; ldc.r8; ldc.r4; ldstr; ldtoken; long br; br.s
            list.Add(
                Raw(
                    []int32{
                        0x21,
                        1,
                        2,
                        3,
                        4,
                        5,
                        6,
                        7,
                        8,
                        0x23,
                        1,
                        2,
                        3,
                        4,
                        5,
                        6,
                        7,
                        8,
                        0x22,
                        1,
                        2,
                        3,
                        4,
                        0x72,
                        1,
                        0,
                        0,
                        112,
                        0xD0,
                        1,
                        0,
                        0,
                        2,
                        0x38,
                        0,
                        0,
                        0,
                        0,
                        0x2B,
                        0,
                        0x2A
                    }
                )
            )
            // a lone trailing 0xFE prefix
            list.Add(Raw([]int32{0x17, 0x17, 0x58, 0xFE}))
            // switch whose count is cut off, and one whose targets run past the end
            list.Add(Raw([]int32{0x17, 0x45, 3, 0}))
            list.Add(Raw([]int32{0x17, 0x45, 9, 0, 0, 0, 1, 2}))
            // an undefined two-byte opcode and an undefined one-byte opcode
            list.Add(Raw([]int32{0x17, 0xFE, 0xFF, 5, 0x17, 0xA4, 7, 0x2A}))
            // an operand cut off at the end of the stream
            list.Add(Raw([]int32{0x17, 0x28, 1, 2}))
            // empty stream
            list.Add(Raw([]int32{}))
            return list
        }
    }
}
