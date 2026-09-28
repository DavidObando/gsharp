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
    public void MultipleForwardBranches_BypassingDifferentAssignments_RejectBothReads()
    {
        var result = Evaluate("""
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
            """);

        var nullableReads = result.Diagnostics.Where(d => d.Id == "GS0158").ToArray();
        Assert.Equal(2, nullableReads.Length);
        Assert.All(nullableReads, d => Assert.Equal("Length", d.Location.Text.ToString(d.Location.Span)));
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
