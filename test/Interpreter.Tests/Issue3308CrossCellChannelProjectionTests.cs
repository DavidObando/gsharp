// <copyright file="Issue3308CrossCellChannelProjectionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #3308: a magic-wrapper global hoisted into emitted-REPL session
/// state must keep its symbolic identity in later cells. On main, the #3186
/// submission-as-metadata seam bound a prior cell's global via its CLR
/// projection, so operations that type-check against the magic symbol failed
/// cross-cell: every channel operation (<c>&lt;-ch</c>, <c>ch &lt;- v</c>,
/// <c>select</c> arms, <c>Close()</c>) on a <c>chan[T]</c> global (projected as
/// imported <c>System.Threading.Channels.Channel[T]</c>), and
/// <c>len</c>/<c>append</c> on slice and fixed-array globals (projected as
/// imported <c>T[]</c>). The <c>Pin_*</c> tests pin the kinds that already
/// round-trip correctly through the seam (maps via the erased dictionary
/// member family, sequences via the duck-typed enumerable probes,
/// function-typed globals via the delegate-shape call mapping) so the fix
/// cannot regress them. ADR-0174 removed the <c>Gsharp.Extensions.Go</c>
/// import gate; a later cell's resolver must still carry the bundled channel
/// runtime, which is the second thing these tests now police.
/// </summary>
public sealed class Issue3308CrossCellChannelProjectionTests
{
    [Fact]
    public void ExactRepro_ReceiveFromPriorCellChannel()
    {
        // The issue's repro verbatim, plus a `poke()` cell so the buffered
        // channel has a value before the cross-cell receive.
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, """
            var done = chan[int32](1)
            func poke() {
                done <- 42
            }
            """);
        AssertOk(engine, "poke()");

        var receive = engine.Evaluate("<-done");
        Assert.False(receive.HasError, string.Join("; ", receive.Diagnostics));
        Assert.Equal(42, receive.Value);
    }

    [Fact]
    public void Send_ToPriorCellChannel_ThenReceive()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, """
            var ch = chan[int32](1)
            """);
        AssertOk(engine, "ch <- 7");

        var receive = engine.Evaluate("<-ch");
        Assert.False(receive.HasError, string.Join("; ", receive.Diagnostics));
        Assert.Equal(7, receive.Value);
    }

    [Fact]
    public void SelectReceive_OverPriorCellChannel()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, """
            var ready = chan[int32](1)
            ready <- 5
            """);

        var result = engine.Evaluate("""
            var got = 0
            select {
            case let v = <-ready {
                got = v
            }
            }
            got
            """);
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics));
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void SelectSend_OverPriorCellChannel()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, """
            var sendCh = chan[int32](1)
            """);
        AssertOk(engine, """
            select {
            case sendCh <- 11 {
            }
            }
            """);

        var receive = engine.Evaluate("<-sendCh");
        Assert.False(receive.HasError, string.Join("; ", receive.Diagnostics));
        Assert.Equal(11, receive.Value);
    }

    [Fact]
    public void SelectDefault_OverEmptyPriorCellChannel()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, """
            var empty = chan[int32](1)
            """);

        var result = engine.Evaluate("""
            var picked = 0
            select {
            case let v = <-empty {
                picked = v
            }
            default {
                picked = -1
            }
            }
            picked
            """);
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics));
        Assert.Equal(-1, result.Value);
    }

    [Fact]
    public void GoClosure_CapturingPriorCellChannel_UnbufferedRendezvous()
    {
        // Unbuffered channel: the receive below can only complete when the
        // goroutine spawned in the same (later) cell sends through the
        // channel captured from the prior cell — a real rendezvous.
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, """
            var u = Chan.Unbounded[int32]()
            """);

        var result = engine.Evaluate("""
            go func() {
                u <- 9
            }()
            <-u
            """);
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics));
        Assert.Equal(9, result.Value);
    }

    [Fact]
    public void Close_PriorCellChannel_ThenReceiveGivesZero()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, """
            var c = chan[int32](1)
            """);
        AssertOk(engine, "c.Close()");

        var receive = engine.Evaluate("<-c");
        Assert.False(receive.HasError, string.Join("; ", receive.Diagnostics));
        Assert.Equal(0, receive.Value);
    }

    [Fact]
    public void ReferenceElement_StringChannel_CrossCellSendReceive()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, """
            var sc = chan[string](1)
            """);
        AssertOk(engine, "sc <- \"hi\"");

        var receive = engine.Evaluate("<-sc");
        Assert.False(receive.HasError, string.Join("; ", receive.Diagnostics));
        Assert.Equal("hi", receive.Value);
    }

    [Fact]
    public void UserStructElement_CrossCellSendReceive()
    {
        // A user-struct element type: the cross-cell reverse projection must
        // rebuild `chan[Point]` over the current resolver's view of the prior
        // cell's emitted Point type so a later cell can send a composite
        // literal and read fields off the received value.
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, """
            struct Point {
                var X int32
                var Y int32
            }
            var pc = chan[Point](1)
            """);
        AssertOk(engine, "pc <- Point{X: 3, Y: 4}");

        var result = engine.Evaluate("""
            var p = <-pc
            p.X + p.Y
            """);
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics));
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void Reassign_PriorCellChannelGlobal_ThenUse()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, """
            var rc = chan[int32](1)
            """);
        AssertOk(engine, "rc = chan[int32](2)");
        AssertOk(engine, "rc <- 21");

        var receive = engine.Evaluate("<-rc");
        Assert.False(receive.HasError, string.Join("; ", receive.Diagnostics));
        Assert.Equal(21, receive.Value);
    }

    [Fact]
    public void Slice_CrossCellLenIndexAppend()
    {
        // A slice global projects as imported `T[]`: indexing already worked
        // through the CLR array path, but `len`/`append` type-check against
        // SliceTypeSymbol and were rejected cross-cell on main.
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, "var xs = []int32{1, 2, 3}");

        var lenProbe = engine.Evaluate("xs.Length");
        Assert.False(lenProbe.HasError, string.Join("; ", lenProbe.Diagnostics));
        Assert.Equal(3, lenProbe.Value);

        var indexProbe = engine.Evaluate("xs[1]");
        Assert.False(indexProbe.HasError, string.Join("; ", indexProbe.Diagnostics));
        Assert.Equal(2, indexProbe.Value);

        AssertOk(engine, "xs = []int32{xs[0], xs[1], xs[2], 4}");
        var appended = engine.Evaluate("xs.Length");
        Assert.False(appended.HasError, string.Join("; ", appended.Diagnostics));
        Assert.Equal(4, appended.Value);

        // Indexed write through the reverse-projected slice receiver mutates
        // the stored global in place.
        AssertOk(engine, "xs[0] = 9");
        var written = engine.Evaluate("xs[0]");
        Assert.False(written.HasError, string.Join("; ", written.Diagnostics));
        Assert.Equal(9, written.Value);
    }

    [Fact]
    public void FixedArray_CrossCellIndexAndLen()
    {
        // A fixed array `[N]T` projects as the same imported `T[]` a slice
        // does — the reverse projection recovers N from the declaring cell's
        // source-side type.
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, "var a = [3]int32{1, 2, 3}");

        var indexProbe = engine.Evaluate("a[2]");
        Assert.False(indexProbe.HasError, string.Join("; ", indexProbe.Diagnostics));
        Assert.Equal(3, indexProbe.Value);

        var lenProbe = engine.Evaluate("a.Length");
        Assert.False(lenProbe.HasError, string.Join("; ", lenProbe.Diagnostics));
        Assert.Equal(3, lenProbe.Value);

        // Indexed write through the reverse-projected fixed-array receiver
        // mutates the stored global in place.
        AssertOk(engine, "a[0] = 9");
        var written = engine.Evaluate("a[0]");
        Assert.False(written.HasError, string.Join("; ", written.Diagnostics));
        Assert.Equal(9, written.Value);
    }

    [Fact]
    public void Pin_Map_CrossCellIndexReadWrite()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, "var m = map[string, int32]{\"a\": 1}");
        AssertOk(engine, "m[\"b\"] = 2");

        var probe = engine.Evaluate("m[\"a\"] + m[\"b\"]");
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics));
        Assert.Equal(3, probe.Value);
    }

    [Fact]
    public void Pin_Sequence_CrossCellIteration()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, """
            func gen() sequence[int32] {
                yield 10
                yield 20
                yield 30
            }
            var q = gen()
            """);

        var result = engine.Evaluate("""
            var sum = 0
            for v in q {
                sum = sum + v
            }
            sum
            """);
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics));
        Assert.Equal(60, result.Value);
    }

    [Fact]
    public void Pin_AsyncSequence_CrossCellAwaitForIteration()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, """
            import System.Threading.Tasks

            async func gen() sequence[int32] {
                yield 1
                await Task.Yield()
                yield 2
            }
            var aq = gen()
            """);

        var result = engine.Evaluate("""
            var sum = 0
            await for v in aq {
                sum = sum + v
            }
            sum
            """);
        Assert.False(result.HasError, string.Join("; ", result.Diagnostics));
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void Pin_FunctionTypedGlobal_CrossCellCall()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, "var f = func(x int32) int32 { return x + 1 }");

        var call = engine.Evaluate("f(41)");
        Assert.False(call.HasError, string.Join("; ", call.Diagnostics));
        Assert.Equal(42, call.Value);
    }

    private static void AssertOk(EmittedSessionEngine engine, string cell)
    {
        var result = engine.Evaluate(cell);
        Assert.False(result.HasError, $"cell '{cell}': {string.Join("; ", result.Diagnostics)}");
    }
}
