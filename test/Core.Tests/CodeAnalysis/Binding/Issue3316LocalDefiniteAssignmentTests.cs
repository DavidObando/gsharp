// <copyright file="Issue3316LocalDefiniteAssignmentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3316 / ADR-0159 follow-up (a): definite-assignment analysis for
/// no-zero-value locals, with the GS0520 channel carve-out as the first
/// consumer. A bare <c>chan[T]</c> LOCAL now declares freely (on main the
/// declaration itself reported GS0520); the error moves to any USE that
/// some control-flow path can reach without a preceding assignment
/// (GS0522 — C#'s CS0165 model). Zero-valued kinds (ints, maps/slices/
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


            func run() int32 {
                var c chan[int32]
                c = chan[int32](1)
                c <- 7
                return <-c
            }

            run()
            """);

        AssertNoErrors(result);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void UseBeforeAnyAssignment_Receive_ReportsGS0522()
    {
        var result = Compile("""
            package P3316UseRecv


            func run() int32 {
                var c chan[int32]
                return <-c
            }

            run()
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0522");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0520");
    }

    [Fact]
    public void UseBeforeAnyAssignment_Send_ReportsGS0522()
    {
        var result = Compile("""
            package P3316UseSend


            func run() int32 {
                var c chan[int32]
                c <- 1
                return 0
            }

            run()
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0522");
    }

    [Fact]
    public void UseBeforeAnyAssignment_PassedAsArgument_ReportsGS0522()
    {
        var result = Compile("""
            package P3316UseArg


            func take(ch chan[int32]) int32 {
                return 0
            }

            func run() int32 {
                var c chan[int32]
                return take(c)
            }

            run()
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0522");
    }

    [Fact]
    public void ExplicitDefaultInitializer_CountsAsAssignment()
    {
        // ADR-0159 honesty clause: `= default` keeps its CLR meaning — the
        // user explicitly opted into the null slot, so no GS0522.
        var result = Compile("""
            package P3316ExplicitDefault


            func run() int32 {
                var c chan[int32] = default
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


            func run(cond bool) int32 {
                var c chan[int32]
                if cond {
                    c = chan[int32](1)
                    c <- 1
                } else {
                    c = chan[int32](1)
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
    public void If_OnlyThenArmAssigns_UseAfterJoin_ReportsGS0522()
    {
        var result = Compile("""
            package P3316IfOne


            func run(cond bool) int32 {
                var c chan[int32]
                if cond {
                    c = chan[int32](1)
                }
                c <- 1
                return 0
            }

            run(true)
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0522");
    }

    [Fact]
    public void If_ElseArmReturnsEarly_AssignOnFallThrough_IsLegal()
    {
        // The non-assigning path leaves the function, so the use is only
        // reachable through the assignment.
        var result = Compile("""
            package P3316IfEarlyReturn


            func run(cond bool) int32 {
                var c chan[int32]
                if cond {
                    return 0
                }
                c = chan[int32](1)
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
    public void Loop_AssignOnlyInBody_UseAfterLoop_ReportsGS0522()
    {
        // The C# rule: a loop body may execute zero times, so an assignment
        // inside it does not reach the code after the loop.
        var result = Compile("""
            package P3316LoopAfter


            func run(n int32) int32 {
                var c chan[int32]
                var i int32
                for i < n {
                    c = chan[int32](1)
                    i = i + 1
                }
                c <- 1
                return 0
            }

            run(0)
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0522");
    }

    [Fact]
    public void Loop_AssignBeforeLoop_UseInsideBody_IsLegal()
    {
        var result = Compile("""
            package P3316LoopBefore


            func run() int32 {
                var c chan[int32]
                c = chan[int32](3)
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


            func run() int32 {
                var total int32 = 0
                var i int32 = 0
                for i < 2 {
                    var c chan[int32]
                    c = chan[int32](1)
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
    public void Try_AssignOnlyInTryBody_UseAfter_ReportsGS0522()
    {
        // An exception can skip the try-body assignment and land in the
        // (non-assigning) catch, then fall through to the use.
        var result = Compile("""
            package P3316TryOnly

            import System

            func run() int32 {
                var c chan[int32]
                try {
                    c = chan[int32](1)
                } catch (e Exception) {
                }
                c <- 1
                return 0
            }

            run()
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0522");
    }

    [Fact]
    public void Try_AssignInTryAndEveryCatch_UseAfter_IsLegal()
    {
        var result = Compile("""
            package P3316TryCatchBoth

            import System

            func run() int32 {
                var c chan[int32]
                try {
                    c = chan[int32](1)
                    c <- 1
                } catch (e Exception) {
                    c = chan[int32](1)
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

            func run() int32 {
                var c chan[int32]
                try {
                } finally {
                    c = chan[int32](1)
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


            func run(x int32) int32 {
                var c chan[int32]
                switch x {
                case 1 {
                    c = chan[int32](1)
                    c <- 1
                }
                default {
                    c = chan[int32](1)
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
    public void Switch_NoDefault_UseAfter_ReportsGS0522()
    {
        // Without a default the discriminant can match no arm at all; that
        // "nothing matched" path reaches the use unassigned.
        var result = Compile("""
            package P3316SwitchNoDefault


            func run(x int32) int32 {
                var c chan[int32]
                switch x {
                case 1 {
                    c = chan[int32](1)
                }
                }
                c <- 1
                return 0
            }

            run(1)
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0522");
    }

    [Fact]
    public void Select_EveryArmAssigns_UseAfter_IsLegal()
    {
        // select always runs exactly one arm, so an assignment in every arm
        // reaches the code after it.
        var result = Compile("""
            package P3316SelectAll


            func run() int32 {
                let ready = chan[int32](1)
                ready <- 3
                var c chan[int32]
                select {
                case let v = <-ready {
                    c = chan[int32](1)
                    c <- v
                }
                default {
                    c = chan[int32](1)
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
    public void Select_UnassignedLocalAsCaseChannel_ReportsGS0522()
    {
        var result = Compile("""
            package P3316SelectChan


            func run() int32 {
                var c chan[int32]
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

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0522");
    }

    // ----- Captures (lambdas / goroutines) ---------------------------------

    [Fact]
    public void Capture_BeforeAnyAssignment_UseInsideLiteral_ReportsGS0522()
    {
        // The C# model: a use inside the literal is checked against the
        // assignment state at the capture point — assigning AFTER creating
        // the closure does not make the captured use safe.
        var result = Compile("""
            package P3316CaptureBefore


            func run() int32 {
                var c chan[int32]
                let f = func() int32 { return <-c }
                c = chan[int32](1)
                c <- 1
                return f()
            }

            run()
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0522");
    }

    [Fact]
    public void Capture_AfterAssignment_UseInsideLiteral_IsLegal()
    {
        var result = Compile("""
            package P3316CaptureAfter


            func run() int32 {
                var c chan[int32]
                c = chan[int32](1)
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
        // GoStatement's expression — legal once assigned. (At the time this
        // test was written, the closure-capturing spelling
        // `go func() { c <- 11 }()` tripped a pre-existing emit defect —
        // GS9998 "Variable 'c' has no local slot" — unrelated to definite
        // assignment, so this witness used the argument-passing shape the Go
        // samples use. That defect is now fixed by #3323 — see
        // Issue3323GoroutineChannelCaptureTests, including its
        // Goroutine_InlineLiteral_CapturesChannel_DeclaredThenAssignedBeforeGo
        // witness for the identical declare-then-assign-then-capture shape —
        // but this test keeps the argument-passing spelling as a stable,
        // definite-assignment-focused witness.)
        var result = Compile("""
            package P3316Goroutine


            func send(ch chan[int32]) int32 {
                ch <- 11
                return 0
            }

            func run() int32 {
                var c chan[int32]
                c = Chan.Unbounded[int32]()
                go send(c)
                return <-c
            }

            run()
            """);

        AssertNoErrors(result);
        Assert.Equal(11, result.Value);
    }

    [Fact]
    public void Goroutine_CapturesUnassignedLocal_ReportsGS0522()
    {
        var result = Compile("""
            package P3316GoroutineBad


            func run() int32 {
                var c chan[int32]
                go func() {
                    c <- 11
                }()
                c = Chan.Unbounded[int32]()
                return <-c
            }

            run()
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0522");
    }

    // ----- out arguments count as assignment --------------------------------

    [Fact]
    public void OutArgument_CountsAsAssignment_UseAfter_IsLegal()
    {
        var result = Compile("""
            package P3316OutArg


            func mk(out ch chan[int32]) {
                ch = chan[int32](1)
            }

            func run() int32 {
                var c chan[int32]
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


            func run() int32 {
                var i int32
                var m map[int32, int32]
                var sl []int32
                m[1] = i
                return m[1] + sl.Length
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


            var c chan[int32]
            0
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0520");
    }

    [Fact]
    public void ChannelParameter_IsAssignedOnEntry_NoDiagnostic()
    {
        var result = Compile("""
            package P3316Param


            func drain(c chan[int32]) int32 {
                return <-c
            }

            func run() int32 {
                let c = chan[int32](1)
                c <- 12
                return drain(c)
            }

            run()
            """);

        AssertNoErrors(result);
        Assert.Equal(12, result.Value);
    }
}
