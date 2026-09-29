// <copyright file="Issue4519GotoAssignmentNarrowingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4519: a forward <c>goto</c> must not inherit assignment narrowing
/// performed only on the skipped fallthrough path.
/// </summary>
public class Issue4519GotoAssignmentNarrowingTests
{
    [Fact]
    public void ForwardGoto_BypassesAssignment_ReportsNullableReceiver()
    {
        var result = Evaluate("""
            func Run(cond bool) string {
                var x string? = nil
                if cond {
                    goto SkipAssign
                }
                x = "hello"
            SkipAssign:
                return x.Length.ToString()
            }

            Run(true)
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void DirectFallthroughAssignment_RemainsNarrowed()
    {
        AssertRuns("""
            import System

            func Run() {
                var x string? = nil
                x = "hello"
                Console.WriteLine(x.Length)
            }

            Run()
            """, "5");
    }

    [Fact]
    public void BackwardGoto_AfterDominatingAssignment_RemainsNarrowed()
    {
        AssertRuns("""
            import System

            func Run() {
                var x string? = nil
                x = "ok"
                var count = 0
            Again:
                Console.WriteLine(x.Length)
                count++
                if count < 2 {
                    goto Again
                }
            }

            Run()
            """, "2", "2");
    }

    [Fact]
    public void BackwardGoto_AfterNullableAssignment_ReportsNullableReceiver()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x string? = nil
                x = "safe"
                var count = 0
            Again:
                let length = x.Length
                if count == 0 {
                    count++
                    x = nil
                    goto Again
                }
                return length
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_AfterNullableAssignment_ReportsNullableMethodReceiver()
    {
        var result = Evaluate("""
            func Run() string {
                var x string? = nil
                x = "safe"
                var count = 0
            Again:
                let value = x.ToString()
                if count == 0 {
                    count++
                    x = nil
                    goto Again
                }
                return value
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0159");
        Assert.Equal("ToString", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_AfterNullableAssignment_ReportsNonNullConversion()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x string? = nil
                x = "safe"
                var count = 0
            Again:
                let y string = x
                if count == 0 {
                    count++
                    x = nil
                    goto Again
                }
                return y.Length
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0155");
        Assert.Equal("x", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_AfterNullableAssignment_ReportsIndexReceiver()
    {
        var result = Evaluate("""
            func Run() char {
                var x string? = nil
                x = "safe"
                var count = 0
            Again:
                let first = x[0]
                if count == 0 {
                    count++
                    x = nil
                    goto Again
                }
                return first
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0116");
        Assert.Equal("x", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_AfterNullableAssignment_ReportsIndirectInvocation()
    {
        var result = Evaluate("""
            import System

            func Run() int32 {
                var f Func[int32]? = nil
                f = () -> 1
                var count = 0
            Again:
                let value = f()
                if count == 0 {
                    count++
                    f = nil
                    goto Again
                }
                return value
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0159");
        Assert.Equal("f", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_InvalidationPropagatesThroughForwardLabel()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x string? = nil
                x = "safe"
                var count = 0
            Again:
                if count == 0 {
                    count++
                    goto Use
                }
                x = "safe"
            Use:
                let length = x.Length
                if count == 1 {
                    count++
                    x = nil
                    goto Again
                }
                return length
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_RepeatedGuardReestablishesNarrowing()
    {
        AssertRuns("""
            import System

            func Run() int32 {
                var x string? = "safe"
                var count = 0
            Again:
                if x != nil {
                    Console.WriteLine(x.Length)
                }
                if count == 0 {
                    count++
                    x = nil
                    goto Again
                }
                return count
            }

            Console.WriteLine(Run())
            """, "4", "1");
    }

    [Fact]
    public void BackwardGoto_AfterPostLabelNonNullAssignment_RemainsNarrowed()
    {
        AssertRuns("""
            import System

            func Run() int32 {
                var x string? = nil
                x = "safe"
                var count = 0
            Again: {
                    x = "safe"
                    let length = x.Length
                    if count == 0 {
                        count++
                        x = nil
                        goto Again
                    }
                    return length
                }
            }

            Console.WriteLine(Run())
            """, "4");
    }

    [Fact]
    public void BackwardGoto_ThroughFinallyMutation_ReportsNullableReceiver()
    {
        var result = Evaluate("""
            func Run() int32 {
                var x string? = nil
                x = "safe"
                var count = 0
            Again:
                let length = x.Length
                if count == 0 {
                    count++
                    try {
                        goto Again
                    } finally {
                        x = nil
                    }
                }
                return length
            }

            Run()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void BackwardGoto_ThroughNonNullFinallyAssignment_RemainsNarrowed()
    {
        AssertRuns("""
            import System

            func Run() int32 {
                var x string? = nil
                x = "safe"
                var count = 0
            Again:
                let length = x.Length
                if count == 0 {
                    count++
                    try {
                        x = nil
                        goto Again
                    } finally {
                        x = "safe"
                    }
                }
                return length
            }

            Console.WriteLine(Run())
            """, "4");
    }

    [Fact]
    public void BackwardGoto_ThroughNonCompletingFinally_DoesNotInvalidate()
    {
        AssertRuns("""
            import System

            func Run() int32 {
                var x string? = nil
                x = "safe"
                var count = 0
            Again:
                let length = x.Length
                if count == 0 {
                    count++
                    try {
                        goto Again
                    } finally {
                        return 0
                    }
                }
                return length
            }

            Console.WriteLine(Run())
            """, "0");
    }

    [Fact]
    public void NestedFunction_BackwardGotoUsesIndependentJoinState()
    {
        var result = Evaluate("""
            func Outer() int32 {
                var inner = func() int32 {
                    var x string? = nil
                    x = "safe"
                    var count = 0
                Again:
                    let length = x.Length
                    if count == 0 {
                        count++
                        x = nil
                        goto Again
                    }
                    return length
                }
                return inner()
            }

            Outer()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void MultipleForwardBranches_BypassingDifferentAssignments_RejectBothReads()
    {
        const string source = """
            func Run(first bool, second bool) int32 {
                var x string? = nil
                var y string? = nil
                if first { goto AfterX }
                x = "x"
            AfterX:
                if second { goto AfterY }
                y = "yy"
            AfterY:
                return x.Length + y.Length
            }

            Run(true, true)
            """;
        var result = Evaluate(source);

        var nullableReads = result.Diagnostics.Where(d => d.Id == "GS0158").ToArray();
        Assert.Equal(2, nullableReads.Length);
        Assert.All(nullableReads, d => Assert.Equal("Length", d.Location.Text.ToString(d.Location.Span)));
        Assert.Equal(
            new[]
            {
                source.IndexOf("x.Length", StringComparison.Ordinal) + "x.".Length,
                source.IndexOf("y.Length", StringComparison.Ordinal) + "y.".Length,
            },
            nullableReads.Select(d => d.Location.Span.Start).OrderBy(position => position));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void MultipleGotosToSameLabel_IntersectTheirNarrowingStates()
    {
        var result = Evaluate("""
            func Run(first bool, second bool) int32 {
                var x string? = nil
                if first { goto Done }
                x = "safe"
                if second { goto Done }
            Done:
                return x.Length
            }

            Run(true, false)
            """);

        Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void AssignmentBeforeEveryForwardJump_RemainsNarrowedAtLabel()
    {
        AssertRuns("""
            import System

            func Run(jump bool) {
                var x string? = nil
                x = "safe"
                if jump { goto Done }
                x = "also safe"
            Done:
                Console.WriteLine(x.Length)
            }

            Run(true)
            Run(false)
            """, "4", "9");
    }

    [Fact]
    public void ForwardGoto_BypassesConditionalValueAssignment_ReportsNullableReceiver()
    {
        var result = Evaluate("""
            func Run(jump bool, choose bool) int32 {
                var x string? = nil
                if jump { goto Done }
                x = if choose { "a" } else { "bb" }
            Done:
                return x.Length
            }

            Run(true, false)
            """);

        Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void ForwardGotoFromNestedScope_InvalidatesOnlyBypassedLocal()
    {
        var result = Evaluate("""
            func Run(jump bool) int32 {
                var safe string? = nil
                var skipped string? = nil
                safe = "safe"
                if jump {
                    if true {
                        goto Done
                    }
                }
                skipped = "skip"
            Done:
                return safe.Length + skipped.Length
            }

            Run(true)
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        var text = diagnostic.Location.Text.ToString();
        Assert.Equal(
            text.IndexOf("skipped.Length", StringComparison.Ordinal) + "skipped.".Length,
            diagnostic.Location.Span.Start);
    }

    [Fact]
    public void AssignmentAtTargetAfterOtherLabels_RemainsNarrowed()
    {
        AssertRuns("""
            import System

            func Run(jump bool) {
                var text string? = nil
                if jump { goto Assign }
            Other:
                Console.WriteLine("unreachable")
            Assign:
                Console.WriteLine("assign")
                text = "text"
                Console.WriteLine(text.Length)
            }

            Run(true)
            """, "assign", "4");
    }

    [Fact]
    public void NestedFunction_UsesIndependentGotoJoinState()
    {
        var result = Evaluate("""
            func Outer() int32 {
                var x string? = nil
                x = "outer"
                var inner = func(jump bool) int32 {
                    var y string? = nil
                    if jump { goto Done }
                    y = "inner"
                Done:
                    return y.Length
                }
                return x.Length + inner(true)
            }

            Outer()
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
    }

    [Fact]
    public void GotoLeavingTry_AppliesFinallyMutationBeforeLabelJoin()
    {
        var result = Evaluate("""
            func Run(jump bool) int32 {
                var x string? = nil
                x = "safe"
                try {
                    if jump { goto Done }
                } finally {
                    x = nil
                }
                x = "again"
            Done:
                return x.Length
            }

            Run(true)
            """);

        Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void GotoLeavingTry_PreservesNarrowingWhenFinallyAssignsNonNull()
    {
        AssertRuns("""
            import System

            func Run(jump bool) {
                var x string? = nil
                x = "safe"
                try {
                    if jump { goto Done }
                } finally {
                    x = "final"
                }
                x = "again"
            Done:
                Console.WriteLine(x.Length)
            }

            Run(true)
            """, "5");
    }

    [Fact]
    public void GotoLeavingTry_UsesNarrowingEstablishedByFinally()
    {
        AssertRuns("""
            import System

            func Run(jump bool) {
                var x string? = nil
                try {
                    if jump { goto Done }
                } finally {
                    x = "final"
                }
                x = "again"
            Done:
                Console.WriteLine(x.Length)
            }

            Run(true)
            """, "5");
    }

    [Fact]
    public void ConditionalFinallyAssignment_DoesNotEstablishNarrowing()
    {
        var result = Evaluate("""
            func Run(jump bool, assign bool) int32 {
                var x string? = nil
                try {
                    if jump { goto Done }
                } finally {
                    if assign { x = "final" }
                }
                x = "again"
            Done:
                return x.Length
            }

            Run(true, false)
            """);

        Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
    }

    [Fact]
    public void LocalGotoInFinally_DoesNotDropNullableExitPath()
    {
        var result = Evaluate("""
            func Run(jump bool, skip bool) int32 {
                var x string? = nil
                try {
                    if jump { goto Done }
                } finally {
                    if skip {
                        x = nil
                        goto EndFinally
                    }
                    x = "safe"
                EndFinally:
                }
                x = "again"
            Done:
                return x.Length
            }

            Run(true, true)
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void LocalGotoInFinally_RemainsInMultipleGotoJoin()
    {
        var result = Evaluate("""
            func Run(throughFinally bool, direct bool, skip bool) int32 {
                var x string? = nil
                if throughFinally {
                    try {
                        goto Done
                    } finally {
                        if skip {
                            x = nil
                            goto EndFinally
                        }
                        x = "safe"
                    EndFinally:
                    }
                }
                x = "safe"
                if direct { goto Done }
            Done:
                return x.Length
            }

            Run(true, false, true)
            """);

        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.Equal("Length", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void NestedFinally_EstablishesNarrowingForOuterGoto()
    {
        AssertRuns("""
            import System

            func Run(jump bool) {
                var x string? = nil
                try {
                    if jump { goto Done }
                } finally {
                    try {
                    } finally {
                        x = "safe"
                    }
                }
                x = "again"
            Done:
                Console.WriteLine(x.Length)
            }

            Run(true)
            """, "4");
    }

    [Fact]
    public void NonCompletingFinally_DoesNotInvalidateFallthroughNarrowing()
    {
        AssertRuns("""
            import System

            func Run(jump bool) int32 {
                var x string? = nil
                if jump {
                    try {
                        goto Done
                    } finally {
                        return 0
                    }
                }
                x = "safe"
            Done:
                return x.Length
            }

            Console.WriteLine(Run(false))
            """, "4");
    }

    [Fact]
    public void NestedFunctionBetweenFinallyAndTarget_DoesNotLoseOuterFinallyEffects()
    {
        var result = Evaluate("""
            func Run(jump bool) int32 {
                var x string? = nil
                x = "safe"
                try {
                    if jump { goto Done }
                } finally {
                    x = nil
                }
                var helper = func() int32 {
                    try {
                        return 1
                    } finally {
                    }
                }
                x = "again"
            Done:
                return x.Length
            }

            Run(true)
            """);

        Assert.Single(result.Diagnostics, d => d.Id == "GS0158");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    private static EmittedOracleResult Evaluate(string source)
        => EmittedOracle.Evaluate(source);

    private static void AssertRuns(string source, params string[] expectedLines)
    {
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(
            string.Join(Environment.NewLine, expectedLines) + Environment.NewLine,
            result.Output.ReplaceLineEndings(Environment.NewLine));
    }
}
