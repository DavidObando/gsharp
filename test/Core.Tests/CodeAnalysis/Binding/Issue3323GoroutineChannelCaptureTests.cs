// <copyright file="Issue3323GoroutineChannelCaptureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3323: <c>go func() { ... }()</c> — an inline function literal
/// invoked immediately as the goroutine target — crashed emit with GS9998
/// ("no local slot") for ANY captured local, not just channels. The issue's
/// repro happened to use a channel, and #3316's witness matrix deliberately
/// routed around the inline spelling using <c>go f(c)</c> argument-passing
/// instead, but the actual defect lives one level below the binder: the
/// go-statement's own emit-time capture walk
/// (<c>SlotPlanner.GoCapturedVariableCollector</c>) treats a nested
/// <see cref="GSharp.Core.CodeAnalysis.Binding.BoundFunctionLiteralExpression"/>
/// as an opaque leaf (matching <c>BoundTreeWalker</c>'s general contract that
/// a literal's body is a separate lexical scope) WITHOUT folding the
/// literal's own (already-resolved) <c>CapturedVariables</c> into the
/// go-wrapper's capture set — unlike <c>LambdaBinder.CapturedVariableCollector</c>,
/// which does exactly that for ordinary (non-go) nested-lambda captures
/// (the #503 follow-up). So the go-wrapper display class got no field for
/// the inner literal's captures, and the wrapper's embedded literal-creation
/// code — itself left unrewritten, since <c>CaptureRewriter</c> is equally
/// opaque to nested literals — tried to read the captured local straight off
/// the go-wrapper's <c>InvokeAction</c> method, where it has no local slot.
/// The fix folds <c>BoundFunctionLiteralExpression.CapturedVariables</c> into
/// <c>GoCapturedVariableCollector</c>'s own capture set, mirroring the
/// existing non-go mechanism. Coverage below spans the channel shapes the
/// issue asked for, plus a non-channel (int) witness proving the fix is not
/// channel-specific.
/// </summary>
public class Issue3323GoroutineChannelCaptureTests
{
    private static EmittedOracleResult Compile(string source) => EmittedOracle.Evaluate(source);

    private static void AssertNoErrors(EmittedOracleResult result)
    {
        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
    }

    [Fact]
    public void Goroutine_InlineLiteral_CapturesChannel_SendThenReceive()
    {
        // Exact repro from #3323.
        var result = Compile("""
            package P3323Repro


            func run() int32 {
                var c = Chan.Unbounded[int32]()
                go func() { c <- 42 }()
                return <-c
            }

            run()
            """);

        AssertNoErrors(result);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void Goroutine_InlineLiteral_CapturesChannel_ReadOnly()
    {
        // The closure only ever *receives* from the captured channel and
        // forwards the value onward — a read-only capture shape.
        var result = Compile("""
            package P3323ReadOnly


            func run() int32 {
                var c = chan[int32](1)
                c <- 99
                var out = chan[int32](1)
                go func() {
                    out <- <-c
                }()
                return <-out
            }

            run()
            """);

        AssertNoErrors(result);
        Assert.Equal(99, result.Value);
    }

    [Fact]
    public void Goroutine_InlineLiteral_CapturesChannel_ReadAndWrite()
    {
        // The closure both sends to and receives from the same captured
        // channel — a read-write capture shape.
        var result = Compile("""
            package P3323ReadWrite


            func run() int32 {
                var c = chan[int32](1)
                var out = chan[int32](1)
                go func() {
                    c <- 5
                    out <- <-c + 1
                }()
                return <-out
            }

            run()
            """);

        AssertNoErrors(result);
        Assert.Equal(6, result.Value);
    }

    [Fact]
    public void Goroutine_InlineLiteral_CapturesChannel_Close()
    {
        // `c.Close()` on a captured channel — a third capture shape distinct
        // from send/receive. Receiving from a closed channel yields the
        // element type's zero value.
        var result = Compile("""
            package P3323Close


            func run() int32 {
                var c = chan[int32](1)
                var done = chan[int32](1)
                go func() {
                    c.Close()
                    done <- 1
                }()
                <-done
                return <-c
            }

            run()
            """);

        AssertNoErrors(result);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void Goroutine_InlineLiteral_CapturesMultipleChannels_PlusOtherTypes()
    {
        // Two channels captured alongside an int, a string, and a struct in
        // the same closure — regression coverage for the general capture
        // path (LambdaBinder.CollectFunctionLiterals still needs to resolve
        // literal.CapturedVariables correctly for every kind; this pins that
        // SlotPlanner's fold-in doesn't disturb it).
        var result = Compile("""
            package P3323MultiChannelMixedTypes


            struct Point {
                var X int32
                var Y int32
            }

            func run() int32 {
                var ch1 = chan[int32](1)
                var ch2 = chan[int32](1)
                var n = 3
                var s = "hi"
                var p = Point{X: 1, Y: 2}
                var done = chan[int32](1)
                go func() {
                    ch1 <- n + p.X
                    ch2 <- int32(s.Length) + p.Y
                    done <- 1
                }()
                <-done
                return <-ch1 + <-ch2
            }

            run()
            """);

        AssertNoErrors(result);
        Assert.Equal(8, result.Value);
    }

    [Fact]
    public void Goroutine_InlineLiteral_CapturesChannel_ReassignedBeforeCapture()
    {
        // `c` is declared with one channel, then reassigned to a different
        // one before the `go` statement captures it — the closure must
        // observe the value at the capture point (the second channel).
        var result = Compile("""
            package P3323Reassigned


            func run() int32 {
                var c = chan[int32](1)
                c = chan[int32](1)
                go func() { c <- 55 }()
                return <-c
            }

            run()
            """);

        AssertNoErrors(result);
        Assert.Equal(55, result.Value);
    }

    [Fact]
    public void Goroutine_InlineLiteral_CapturesChannel_DeclaredThenAssignedBeforeGo()
    {
        // #3316 capture-point semantics: a channel LOCAL declared without an
        // initializer, then assigned before the `go` statement, is legal —
        // the definite-assignment check is against the capture point, not
        // the declaration point. This is the emit-side companion: the
        // capture must also actually work once #3323 is fixed.
        var result = Compile("""
            package P3323DeclareThenAssign


            func run() int32 {
                var c chan[int32]
                c = chan[int32](1)
                go func() { c <- 66 }()
                return <-c
            }

            run()
            """);

        AssertNoErrors(result);
        Assert.Equal(66, result.Value);
    }

    [Fact]
    public void Goroutine_NamedFunctionValueIndirection_CapturesChannel_RegressionGuard()
    {
        // Regression guard: the ALREADY-WORKING spelling that #3316 fell
        // back to precisely because the inline spelling was broken — a
        // named `let send = func() {...}` local, launched by name
        // (`go send()`). Here the go-wrapper's own capture set is just
        // `{send}` (a BoundVariableExpression, not a nested literal), so
        // this shape never went through the buggy path and must keep
        // working unchanged after the fix.
        var result = Compile("""
            package P3323NamedIndirectionGuard


            func run() int32 {
                let ch = chan[int32](1)
                let x = 10
                let send = func() {
                    ch <- x
                }
                go send()
                return <-ch
            }

            run()
            """);

        AssertNoErrors(result);
        Assert.Equal(10, result.Value);
    }

    [Fact]
    public void Goroutine_InlineLiteral_CapturesNonChannelLocal_Int()
    {
        // Proves the fix is not channel-specific: an inline `go func(){...}()`
        // closure capturing a plain int32 local crashed with the identical
        // GS9998 pre-fix (verified manually against origin/main) — the
        // go-wrapper's capture walk doesn't special-case types at all, it
        // just never descended into the nested literal for ANY kind.
        var result = Compile("""
            package P3323IntCapture


            func run() int32 {
                var n = 7
                var out = chan[int32](1)
                go func() {
                    out <- n * 2
                }()
                return <-out
            }

            run()
            """);

        AssertNoErrors(result);
        Assert.Equal(14, result.Value);
    }
}
