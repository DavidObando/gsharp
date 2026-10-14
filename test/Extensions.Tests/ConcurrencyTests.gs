// <copyright file="ConcurrencyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Extensions.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import Gsharp.Concurrency
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics
import System.Reflection
import System.Threading
import System.Threading.Channels
import Xunit

/// ADR-0174 D9: the G#-authored concurrency helpers, exercised against the
/// compiled extension assembly. A G# caller reaches these by bare name — the
/// namespace is implicitly imported and hoists its statics — so they live on
/// the package's `<Program>` type and are reached here the way any
/// foreign caller would.
/// @remarks Discrimination witnesses (ADR-0154): a mutant whose `merge` closes the
/// output before every forwarder has finished breaks
/// (cref:Merge_DeliversEveryValueFromEveryInput_ThenCloses) (values go
/// missing); one that never closes it hangs that test's drain, which is bounded
/// by the test's own timeout; a mutant whose `after` returns a timer that
/// never fires breaks (cref:After_FiresOnce).
open class ConcurrencyTests {
    @Fact
    func Merge_DeliversEveryValueFromEveryInput_ThenCloses() {
        let left = Chan[int32](4)
        let right = Chan[int32](4)
        for var i = 1; i <= 3; i++ {
            left.TrySend(i)
            right.TrySend(i * 10)
        }
        left.Close()
        right.Close()
        let merged = Merge(left, right)
        let seen = List[int32]()
        let deadline = Stopwatch.StartNew()
        while seen.Count < 6 && deadline.Elapsed < TimeSpan.FromSeconds(10) {
            let (value, ok) = ChannelOps.Receive2(merged, CancellationToken.None)
            if !ok {
                break
            }
            seen.Add(value)
        }
        seen.Sort()
        Assert.Equal([]int32{1, 2, 3, 10, 20, 30}, seen)
        // Closed once every input closed: the next receive reports no value.
        let (_, stillOpen) = ChannelOps.Receive2(merged, CancellationToken.None)
        Assert.False(stillOpen)
    }

    @Fact
    func Merge_OneInputClosing_DoesNotCloseTheOutput() {
        let closing = Chan[int32](1)
        let open_ = Chan[int32](1)
        closing.TrySend(7)
        closing.Close()
        let merged = Merge(closing, open_)
        let (first, ok) = ChannelOps.Receive2(merged, CancellationToken.None)
        Assert.True(ok)
        Assert.Equal(7, first)
        open_.TrySend(9)
        let (second, stillOk) = ChannelOps.Receive2(merged, CancellationToken.None)
        Assert.True(stillOk)
        Assert.Equal(9, second)
        open_.Close()
        let (_, drained) = ChannelOps.Receive2(merged, CancellationToken.None)
        Assert.False(drained)
    }

    @Fact
    func After_FiresOnce() {
        let timer = cast[AfterTimer](
            Helpers.GetMethod("after")!!.Invoke(nil, []object{TimeSpan.FromMilliseconds(30)})!!
        )
        Assert.False(timer.HasFired)
        let deadline = Stopwatch.StartNew()
        while !timer.HasFired && deadline.Elapsed < TimeSpan.FromSeconds(10) {
            Thread.Sleep(5)
        }
        Assert.True(timer.HasFired)
        Assert.True(timer.TryReceive(out _, out var ok))
        Assert.True(ok)
        // One shot: the value is consumed exactly once.
        Assert.False(timer.TryReceive(out _, out _))
    }

    @Fact
    func Tick_FiresRepeatedly_AndStopsWhenDisposed() {
        using let timer = cast[TickTimer](
            Helpers.GetMethod("tick")!!.Invoke(nil, []object{TimeSpan.FromMilliseconds(20)})!!
        )
        var fires = 0
        let deadline = Stopwatch.StartNew()
        while fires < 2 && deadline.Elapsed < TimeSpan.FromSeconds(10) {
            if timer.TryReceive(out _, out var ok) && ok {
                fires++
                continue
            }
            Thread.Sleep(5)
        }
        Assert.True(fires >= 2)
        timer.Dispose()
        timer.TryReceive(out _, out _)
        Thread.Sleep(60)
        Assert.False(timer.TryReceive(out _, out _))
    }

    @Fact
    func Chunks_HandsOverWholeBatches_AndEndsWithTheChannel() {
        let source = Chan[int32](16)
        for var i = 1; i <= 5; i++ {
            source.TrySend(i)
        }
        source.Close()
        let batched = ChunksOf(source, 2)
        let seen = List[int32]()
        var batches = 0
        while true {
            let (batch, ok) = ChannelOps.Receive2(batched, CancellationToken.None)
            if !ok {
                break
            }
            batches++
            seen.AddRange(batch.ToArray())
        }
        Assert.Equal([]int32{1, 2, 3, 4, 5}, seen)
        Assert.Equal(3, batches)
    }

    @Fact
    func Chunks_DoesNotWaitToFillABatch() {
        // atLeast = 1 is Go's `range` shape; a full-fill barrier here would
        // stall a pipeline whose producer is slower than the chunk size.
        let source = Chan[int32](16)
        source.TrySend(7)
        let batched = ChunksOf(source, 1024)
        let (batch, ok) = ChannelOps.Receive2(batched, CancellationToken.None)
        Assert.True(ok)
        Assert.Equal([]int32{7}, batch.ToArray())
    }

    @Fact
    func Chunks_OnARendezvousChannel_ReportsGS0562() {
        // The shape D10 exists to encourage, given the one channel that cannot
        // benefit from it.
        let diagnostics = CompileAgainstExtensions(`package P
import System

let slow = chan[int32](0)
let fast = chan[int32](64)

scope {
    for a in chunks(slow, 64) {
        Console.WriteLine(a.Length.ToString())
    }

    for b in chunks(fast, 64) {
        Console.WriteLine(b.Length.ToString())
    }
}`)
        let diagnostic = Assert.Single(diagnostics, (d Diagnostic) -> d.Id == "GS0562")
        Assert.Contains("'slow'", diagnostic.Message)
    }

    shared {
        private let Helpers Type = Assembly.Load("Gsharp.Extensions").GetType("Gsharp.Concurrency.<Program>")!!

        private func CompileAgainstExtensions(source string) ImmutableArray[Diagnostic] {
            let references = ReferenceResolver.WithReferences(
                []string{Assembly.Load("Gsharp.Extensions").Location, typeof(Chan[int32]).Assembly.Location}
            )
            let compilation = Compilation(references, SyntaxTree.Parse(source))
            let program = GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(compilation.GlobalScope, references)
            return compilation.GlobalScope.Diagnostics.AddRange(program.Diagnostics)
        }

        private func ChunksOf(source Chan[int32], size int32) ChannelReader[ReadOnlyMemory[int32]] {
            let chunks = Helpers.GetMethod("chunks")!!.MakeGenericMethod(typeof(int32))
            return cast[ChannelReader[ReadOnlyMemory[int32]]](chunks.Invoke(nil, []object{source, size})!!)
        }

        private func Merge(inputs ...Chan[int32]) ChannelReader[int32] {
            let merge = Helpers.GetMethod("merge")!!.MakeGenericMethod(typeof(int32))
            let packed = Array.CreateInstance(typeof(Channel[int32]), inputs.Length)
            for var i = 0; i < inputs.Length; i++ {
                packed.SetValue(inputs[i], i)
            }
            return cast[ChannelReader[int32]](merge.Invoke(nil, []object{packed})!!)
        }
    }
}
