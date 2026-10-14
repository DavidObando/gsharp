// <copyright file="Issue3308CrossCellChannelProjectionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Repl.Engine
import Xunit

/// Issue #3308: a magic-wrapper global hoisted into emitted-REPL session
/// state must keep its symbolic identity in later cells. On main, the #3186
/// submission-as-metadata seam bound a prior cell's global via its CLR
/// projection, so operations that type-check against the magic symbol failed
/// cross-cell: every channel operation (`<-ch`, `ch <- v`,
/// `select` arms, `Close()`) on a `chan[T]` global (projected as
/// imported `System.Threading.Channels.Channel[T]`), and
/// `len`/`append` on slice and fixed-array globals (projected as
/// imported `T[]`). The `Pin_*` tests pin the kinds that already
/// round-trip correctly through the seam (maps via the erased dictionary
/// member family, sequences via the duck-typed enumerable probes,
/// function-typed globals via the delegate-shape call mapping) so the fix
/// cannot regress them. ADR-0174 removed the `Gsharp.Extensions.Go`
/// import gate; a later cell's resolver must still carry the bundled channel
/// runtime, which is the second thing these tests now police.
class Issue3308CrossCellChannelProjectionTests {
    @Fact
    func ExactRepro_ReceiveFromPriorCellChannel() {
        // The issue's repro verbatim, plus a `poke()` cell so the buffered
        // channel has a value before the cross-cell receive.
        using let engine = EmittedSessionEngine()
        AssertOk(engine, `var done = chan[int32](1)
func poke() {
    done <- 42
}`)
        AssertOk(engine, "poke()")
        let receive = engine.Evaluate("<-done")
        Assert.False(receive.HasError, string.Join("; ", receive.Diagnostics))
        Assert.Equal(42, receive.Value)
    }

    @Fact
    func Send_ToPriorCellChannel_ThenReceive() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, "var ch = chan[int32](1)")
        AssertOk(engine, "ch <- 7")
        let receive = engine.Evaluate("<-ch")
        Assert.False(receive.HasError, string.Join("; ", receive.Diagnostics))
        Assert.Equal(7, receive.Value)
    }

    @Fact
    func SelectReceive_OverPriorCellChannel() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, "var ready = chan[int32](1)\nready <- 5")
        let result = engine.Evaluate(`var got = 0
select {
case let v = <-ready {
    got = v
}
}
got`)
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics))
        Assert.Equal(5, result.Value)
    }

    @Fact
    func SelectSend_OverPriorCellChannel() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, "var sendCh = chan[int32](1)")
        AssertOk(engine, `select {
case sendCh <- 11 {
}
}`)
        let receive = engine.Evaluate("<-sendCh")
        Assert.False(receive.HasError, string.Join("; ", receive.Diagnostics))
        Assert.Equal(11, receive.Value)
    }

    @Fact
    func SelectDefault_OverEmptyPriorCellChannel() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, "var empty = chan[int32](1)")
        let result = engine.Evaluate(`var picked = 0
select {
case let v = <-empty {
    picked = v
}
default {
    picked = -1
}
}
picked`)
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics))
        Assert.Equal(-1, result.Value)
    }

    @Fact
    func GoClosure_CapturingPriorCellChannel_UnbufferedRendezvous() {
        // Unbuffered channel: the receive below can only complete when the
        // goroutine spawned in the same (later) cell sends through the
        // channel captured from the prior cell — a real rendezvous.
        using let engine = EmittedSessionEngine()
        AssertOk(engine, "var u = Chan.Unbounded[int32]()")
        let result = engine.Evaluate(`go func() {
    u <- 9
}()
<-u`)
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics))
        Assert.Equal(9, result.Value)
    }

    @Fact
    func Close_PriorCellChannel_ThenReceiveGivesZero() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, "var c = chan[int32](1)")
        AssertOk(engine, "c.Close()")
        let receive = engine.Evaluate("<-c")
        Assert.False(receive.HasError, string.Join("; ", receive.Diagnostics))
        Assert.Equal(0, receive.Value)
    }

    @Fact
    func ReferenceElement_StringChannel_CrossCellSendReceive() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, "var sc = chan[string](1)")
        AssertOk(engine, "sc <- \"hi\"")
        let receive = engine.Evaluate("<-sc")
        Assert.False(receive.HasError, string.Join("; ", receive.Diagnostics))
        Assert.Equal("hi", receive.Value)
    }

    @Fact
    func UserStructElement_CrossCellSendReceive() {
        // A user-struct element type: the cross-cell reverse projection must
        // rebuild `chan[Point]` over the current resolver's view of the prior
        // cell's emitted Point type so a later cell can send a composite
        // literal and read fields off the received value.
        using let engine = EmittedSessionEngine()
        AssertOk(engine, `struct Point {
    var X int32
    var Y int32
}
var pc = chan[Point](1)`)
        AssertOk(engine, "pc <- Point{X: 3, Y: 4}")
        let result = engine.Evaluate("var p = <-pc\np.X + p.Y")
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics))
        Assert.Equal(7, result.Value)
    }

    @Fact
    func Reassign_PriorCellChannelGlobal_ThenUse() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, "var rc = chan[int32](1)")
        AssertOk(engine, "rc = chan[int32](2)")
        AssertOk(engine, "rc <- 21")
        let receive = engine.Evaluate("<-rc")
        Assert.False(receive.HasError, string.Join("; ", receive.Diagnostics))
        Assert.Equal(21, receive.Value)
    }

    @Fact
    func Slice_CrossCellLenIndexAppend() {
        // A slice global projects as imported `T[]`: indexing already worked
        // through the CLR array path, but `len`/`append` type-check against
        // SliceTypeSymbol and were rejected cross-cell on main.
        using let engine = EmittedSessionEngine()
        AssertOk(engine, "var xs = []int32{1, 2, 3}")
        let lenProbe = engine.Evaluate("xs.Length")
        Assert.False(lenProbe.HasError, string.Join("; ", lenProbe.Diagnostics))
        Assert.Equal(3, lenProbe.Value)
        let indexProbe = engine.Evaluate("xs[1]")
        Assert.False(indexProbe.HasError, string.Join("; ", indexProbe.Diagnostics))
        Assert.Equal(2, indexProbe.Value)
        AssertOk(engine, "xs = []int32{xs[0], xs[1], xs[2], 4}")
        let appended = engine.Evaluate("xs.Length")
        Assert.False(appended.HasError, string.Join("; ", appended.Diagnostics))
        Assert.Equal(4, appended.Value)
        // Indexed write through the reverse-projected slice receiver mutates
        // the stored global in place.
        AssertOk(engine, "xs[0] = 9")
        let written = engine.Evaluate("xs[0]")
        Assert.False(written.HasError, string.Join("; ", written.Diagnostics))
        Assert.Equal(9, written.Value)
    }

    @Fact
    func FixedArray_CrossCellIndexAndLen() {
        // A fixed array `[N]T` projects as the same imported `T[]` a slice
        // does — the reverse projection recovers N from the declaring cell's
        // source-side type.
        using let engine = EmittedSessionEngine()
        AssertOk(engine, "var a = [3]int32{1, 2, 3}")
        let indexProbe = engine.Evaluate("a[2]")
        Assert.False(indexProbe.HasError, string.Join("; ", indexProbe.Diagnostics))
        Assert.Equal(3, indexProbe.Value)
        let lenProbe = engine.Evaluate("a.Length")
        Assert.False(lenProbe.HasError, string.Join("; ", lenProbe.Diagnostics))
        Assert.Equal(3, lenProbe.Value)
        // Indexed write through the reverse-projected fixed-array receiver
        // mutates the stored global in place.
        AssertOk(engine, "a[0] = 9")
        let written = engine.Evaluate("a[0]")
        Assert.False(written.HasError, string.Join("; ", written.Diagnostics))
        Assert.Equal(9, written.Value)
    }

    @Fact
    func Pin_Map_CrossCellIndexReadWrite() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, "var m = map[string, int32]{\"a\": 1}")
        AssertOk(engine, "m[\"b\"] = 2")
        let probe = engine.Evaluate("m[\"a\"] + m[\"b\"]")
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics))
        Assert.Equal(3, probe.Value)
    }

    @Fact
    func Pin_Sequence_CrossCellIteration() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, `func gen() sequence[int32] {
    yield 10
    yield 20
    yield 30
}
var q = gen()`)
        let result = engine.Evaluate(`var sum = 0
for v in q {
    sum = sum + v
}
sum`)
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics))
        Assert.Equal(60, result.Value)
    }

    @Fact
    func Pin_AsyncSequence_CrossCellAwaitForIteration() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, `import System.Threading.Tasks

async func gen() sequence[int32] {
    yield 1
    await Task.Yield()
    yield 2
}
var aq = gen()`)
        let result = engine.Evaluate(`var sum = 0
await for v in aq {
    sum = sum + v
}
sum`)
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics))
        Assert.Equal(3, result.Value)
    }

    @Fact
    func Pin_FunctionTypedGlobal_CrossCellCall() {
        using let engine = EmittedSessionEngine()
        AssertOk(engine, "var f = func(x int32) int32 { return x + 1 }")
        let call = engine.Evaluate("f(41)")
        Assert.False(call.HasError, string.Join("; ", call.Diagnostics))
        Assert.Equal(42, call.Value)
    }

    shared {
        private func AssertOk(engine EmittedSessionEngine, cell string) {
            let result = engine.Evaluate(cell)
            Assert.False(result.HasError, "cell '$cell': ${string.Join("; ", result.Diagnostics)}")
        }
    }
}
