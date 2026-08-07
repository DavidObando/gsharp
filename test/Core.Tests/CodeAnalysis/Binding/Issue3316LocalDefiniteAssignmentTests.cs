// <copyright file="Issue3316LocalDefiniteAssignmentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3316 / ADR-0159 follow-up (a): definite-assignment analysis for
/// no-zero-value locals, with the GS0520 channel carve-out as the first
/// consumer. A bare <c>chan T</c> LOCAL now declares freely (on main the
/// declaration itself reported GS0520); the error moves to any USE that
/// some control-flow path can reach without a preceding assignment
/// (GS0521 — C#'s CS0165 model). Zero-valued kinds (ints, maps/slices/
/// arrays/sequences post-ADR-0159, structs, strings) keep their documented
/// zero-value initialization and are never flow-checked; globals and
/// fields keep the declaration-site GS0520.
/// </summary>
public class Issue3316LocalDefiniteAssignmentTests
{
    private static EmittedOracleResult Compile(string source) => EmittedOracle.Evaluate(source);

    private static void AssertNoErrors(EmittedOracleResult result)
    {
        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
    }

    // ----- Straight line ---------------------------------------------------

    [Fact]
    public void DeclareThenAssignThenUse_StraightLine_IsLegal()
    {
        // The headline witness: Go's declare-then-assign shape. Red on main
        // (GS0520 at the declaration).
        var result = Compile("""
            package P3316Headline

            import Gsharp.Extensions.Go

            func run() int32 {
                var c chan int32
                c = make(chan int32, 1)
                c <- 7
                return <-c
            }

            run()
            """);

        AssertNoErrors(result);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void UseBeforeAnyAssignment_Receive_ReportsGS0521()
    {
        var result = Compile("""
            package P3316UseRecv

            import Gsharp.Extensions.Go

            func run() int32 {
                var c chan int32
                return <-c
            }

            run()
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0521");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0520");
    }

    [Fact]
    public void UseBeforeAnyAssignment_Send_ReportsGS0521()
    {
        var result = Compile("""
            package P3316UseSend

            import Gsharp.Extensions.Go

            func run() int32 {
                var c chan int32
                c <- 1
                return 0
            }

            run()
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0521");
    }

    [Fact]
    public void UseBeforeAnyAssignment_PassedAsArgument_ReportsGS0521()
    {
        var result = Compile("""
            package P3316UseArg

            import Gsharp.Extensions.Go

            func take(ch chan int32) int32 {
                return 0
            }

            func run() int32 {
                var c chan int32
                return take(c)
            }

            run()
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0521");
    }

    [Fact]
    public void ExplicitDefaultInitializer_CountsAsAssignment()
    {
        // ADR-0159 honesty clause: `= default` keeps its CLR meaning — the
        // user explicitly opted into the null slot, so no GS0521.
        var result = Compile("""
            package P3316ExplicitDefault

            import Gsharp.Extensions.Go

            func run() int32 {
                var c chan int32 = default
                if c == nil {
                    return 1
                }
                return 0
            }

            run()
            """);

        AssertNoErrors(result);
        Assert.Equal(1, result.Value);
    }

    // ----- Branch joins ----------------------------------------------------

    [Fact]
    public void IfElse_BothArmsAssign_UseAfterJoin_IsLegal()
    {
        var result = Compile("""
            package P3316IfBoth

            import Gsharp.Extensions.Go

            func run(cond bool) int32 {
                var c chan int32
                if cond {
                    c = make(chan int32, 1)
                    c <- 1
                } else {
                    c = make(chan int32, 1)
                    c <- 2
                }
                return <-c
            }

            run(true)
            """);

        AssertNoErrors(result);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void If_OnlyThenArmAssigns_UseAfterJoin_ReportsGS0521()
    {
        var result = Compile("""
            package P3316IfOne

            import Gsharp.Extensions.Go

            func run(cond bool) int32 {
                var c chan int32
                if cond {
                    c = make(chan int32, 1)
                }
                c <- 1
                return 0
            }

            run(true)
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0521");
    }

    [Fact]
    public void If_ElseArmReturnsEarly_AssignOnFallThrough_IsLegal()
    {
        // The non-assigning path leaves the function, so the use is only
        // reachable through the assignment.
        var result = Compile("""
            package P3316IfEarlyReturn

            import Gsharp.Extensions.Go

            func run(cond bool) int32 {
                var c chan int32
                if cond {
                    return 0
                }
                c = make(chan int32, 1)
                c <- 4
                return <-c
            }

            run(false)
            """);

        AssertNoErrors(result);
        Assert.Equal(4, result.Value);
    }

    // ----- Loops -----------------------------------------------------------

    [Fact]
    public void Loop_AssignOnlyInBody_UseAfterLoop_ReportsGS0521()
    {
        // The C# rule: a loop body may execute zero times, so an assignment
        // inside it does not reach the code after the loop.
        var result = Compile("""
            package P3316LoopAfter

            import Gsharp.Extensions.Go

            func run(n int32) int32 {
                var c chan int32
                var i int32
                for i < n {
                    c = make(chan int32, 1)
                    i = i + 1
                }
                c <- 1
                return 0
            }

            run(0)
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0521");
    }

    [Fact]
    public void Loop_AssignBeforeLoop_UseInsideBody_IsLegal()
    {
        var result = Compile("""
            package P3316LoopBefore

            import Gsharp.Extensions.Go

            func run() int32 {
                var c chan int32
                c = make(chan int32, 3)
                var i int32 = 0
                var total int32 = 0
                for i < 3 {
                    c <- i
                    total = total + <-c
                    i = i + 1
                }
                return total
            }

            run()
            """);

        AssertNoErrors(result);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void Loop_AssignInBody_UseLaterInSameBody_IsLegal()
    {
        // Within one iteration the assignment precedes the use; the back
        // edge carries the assignment too, so every path to the use has it.
        var result = Compile("""
            package P3316LoopSameBody

            import Gsharp.Extensions.Go

            func run() int32 {
                var total int32 = 0
                var i int32 = 0
                for i < 2 {
                    var c chan int32
                    c = make(chan int32, 1)
                    c <- 5
                    total = total + <-c
                    i = i + 1
                }
                return total
            }

            run()
            """);

        AssertNoErrors(result);
        Assert.Equal(10, result.Value);
    }

    // ----- try/catch/finally ----------------------------------------------

    [Fact]
    public void Try_AssignOnlyInTryBody_UseAfter_ReportsGS0521()
    {
        // An exception can skip the try-body assignment and land in the
        // (non-assigning) catch, then fall through to the use.
        var result = Compile("""
            package P3316TryOnly

            import System
            import Gsharp.Extensions.Go

            func run() int32 {
                var c chan int32
                try {
                    c = make(chan int32, 1)
                } catch (e Exception) {
                }
                c <- 1
                return 0
            }

            run()
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0521");
    }

    [Fact]
    public void Try_AssignInTryAndEveryCatch_UseAfter_IsLegal()
    {
        var result = Compile("""
            package P3316TryCatchBoth

            import System
            import Gsharp.Extensions.Go

            func run() int32 {
                var c chan int32
                try {
                    c = make(chan int32, 1)
                    c <- 1
                } catch (e Exception) {
                    c = make(chan int32, 1)
                    c <- 2
                }
                return <-c
            }

            run()
            """);

        AssertNoErrors(result);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void Finally_Assigns_UseAfter_IsLegal()
    {
        // finally always runs before control continues past the statement.
        var result = Compile("""
            package P3316Finally

            import System
            import Gsharp.Extensions.Go

            func run() int32 {
                var c chan int32
                try {
                } finally {
                    c = make(chan int32, 1)
                    c <- 6
                }
                return <-c
            }

            run()
            """);

        AssertNoErrors(result);
        Assert.Equal(6, result.Value);
    }

    // ----- switch / select -------------------------------------------------

    [Fact]
    public void Switch_EveryArmIncludingDefaultAssigns_UseAfter_IsLegal()
    {
        var result = Compile("""
            package P3316SwitchAll

            import Gsharp.Extensions.Go

            func run(x int32) int32 {
                var c chan int32
                switch x {
                case 1 {
                    c = make(chan int32, 1)
                    c <- 1
                }
                default {
                    c = make(chan int32, 1)
                    c <- 2
                }
                }
                return <-c
            }

            run(1)
            """);

        AssertNoErrors(result);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void Switch_NoDefault_UseAfter_ReportsGS0521()
    {
        // Without a default the discriminant can match no arm at all; that
        // "nothing matched" path reaches the use unassigned.
        var result = Compile("""
            package P3316SwitchNoDefault

            import Gsharp.Extensions.Go

            func run(x int32) int32 {
                var c chan int32
                switch x {
                case 1 {
                    c = make(chan int32, 1)
                }
                }
                c <- 1
                return 0
            }

            run(1)
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0521");
    }

    [Fact]
    public void Select_EveryArmAssigns_UseAfter_IsLegal()
    {
        // select always runs exactly one arm, so an assignment in every arm
        // reaches the code after it.
        var result = Compile("""
            package P3316SelectAll

            import Gsharp.Extensions.Go

            func run() int32 {
                let ready = make(chan int32, 1)
                ready <- 3
                var c chan int32
                select {
                case let v = <-ready {
                    c = make(chan int32, 1)
                    c <- v
                }
                default {
                    c = make(chan int32, 1)
                    c <- 9
                }
                }
                return <-c
            }

            run()
            """);

        AssertNoErrors(result);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void Select_UnassignedLocalAsCaseChannel_ReportsGS0521()
    {
        var result = Compile("""
            package P3316SelectChan

            import Gsharp.Extensions.Go

            func run() int32 {
                var c chan int32
                select {
                case let v = <-c {
                    return v
                }
                default {
                    return 0
                }
                }
                return 0
            }

            run()
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0521");
    }

    // ----- Captures (lambdas / goroutines) ---------------------------------

    [Fact]
    public void Capture_BeforeAnyAssignment_UseInsideLiteral_ReportsGS0521()
    {
        // The C# model: a use inside the literal is checked against the
        // assignment state at the capture point — assigning AFTER creating
        // the closure does not make the captured use safe.
        var result = Compile("""
            package P3316CaptureBefore

            import Gsharp.Extensions.Go

            func run() int32 {
                var c chan int32
                let f = func() int32 { return <-c }
                c = make(chan int32, 1)
                c <- 1
                return f()
            }

            run()
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0521");
    }

    [Fact]
    public void Capture_AfterAssignment_UseInsideLiteral_IsLegal()
    {
        var result = Compile("""
            package P3316CaptureAfter

            import Gsharp.Extensions.Go

            func run() int32 {
                var c chan int32
                c = make(chan int32, 1)
                let f = func() int32 {
                    c <- 8
                    return <-c
                }
                return f()
            }

            run()
            """);

        AssertNoErrors(result);
        Assert.Equal(8, result.Value);
    }

    [Fact]
    public void Goroutine_AssignedLocalAsGoArgument_IsLegal()
    {
        // The `go f(c)` argument is a value read of `c` through the
        // GoStatement's expression — legal once assigned. (The closure-
        // capturing spelling `go func() { c <- 11 }()` currently trips a
        // pre-existing emit defect on main — GS9998 "Variable 'c' has no
        // local slot" — unrelated to definite assignment, so this witness
        // uses the argument-passing shape the Go samples use.)
        var result = Compile("""
            package P3316Goroutine

            import Gsharp.Extensions.Go

            func send(ch chan int32) int32 {
                ch <- 11
                return 0
            }

            func run() int32 {
                var c chan int32
                c = make(chan int32)
                go send(c)
                return <-c
            }

            run()
            """);

        AssertNoErrors(result);
        Assert.Equal(11, result.Value);
    }

    [Fact]
    public void Goroutine_CapturesUnassignedLocal_ReportsGS0521()
    {
        var result = Compile("""
            package P3316GoroutineBad

            import Gsharp.Extensions.Go

            func run() int32 {
                var c chan int32
                go func() {
                    c <- 11
                }()
                c = make(chan int32)
                return <-c
            }

            run()
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0521");
    }

    // ----- out arguments count as assignment --------------------------------

    [Fact]
    public void OutArgument_CountsAsAssignment_UseAfter_IsLegal()
    {
        var result = Compile("""
            package P3316OutArg

            import Gsharp.Extensions.Go

            func mk(out ch chan int32) {
                ch = make(chan int32, 1)
            }

            func run() int32 {
                var c chan int32
                mk(&c)
                c <- 3
                return <-c
            }

            run()
            """);

        AssertNoErrors(result);
        Assert.Equal(3, result.Value);
    }

    // ----- No-change pins ---------------------------------------------------

    [Fact]
    public void ZeroValuedKinds_AreNotFlowChecked()
    {
        // The deliberate semantics decision (ADR-0159 addendum): locals whose
        // types HAVE sound zero values keep zero-value initialization — G#'s
        // documented behavior, not C#'s CS0165 — so no definite-assignment
        // diagnostics fire for them.
        var result = Compile("""
            package P3316ZeroValued

            import Gsharp.Extensions.Go

            func run() int32 {
                var i int32
                var m map[int32, int32]
                var sl []int32
                m[1] = i
                return m[1] + len(sl)
            }

            run()
            """);

        AssertNoErrors(result);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void BareChannelGlobal_StillReportsGS0520()
    {
        // Globals are static fields readable from any function or REPL cell;
        // per-function flow analysis cannot police them, so the declaration-
        // site rule stays.
        var result = Compile("""
            package P3316GlobalPin

            import Gsharp.Extensions.Go

            var c chan int32
            0
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0520");
    }

    [Fact]
    public void ChannelParameter_IsAssignedOnEntry_NoDiagnostic()
    {
        var result = Compile("""
            package P3316Param

            import Gsharp.Extensions.Go

            func drain(c chan int32) int32 {
                return <-c
            }

            func run() int32 {
                let c = make(chan int32, 1)
                c <- 12
                return drain(c)
            }

            run()
            """);

        AssertNoErrors(result);
        Assert.Equal(12, result.Value);
    }
}
