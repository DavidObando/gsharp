// <copyright file="Issue3318MapForInReplTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #3318: range-<c>for</c> over <c>map[K, V]</c> through the session
/// engine — same-cell, and cross-cell over a map global declared in a prior
/// cell (the submission-hoisted global path). The two-variable form
/// destructures entries into <c>K</c>/<c>V</c>; the single-variable form
/// yields <c>KeyValuePair[K, V]</c>. Pre-fix both forms failed with GS0116.
/// </summary>
public sealed class Issue3318MapForInReplTests
{
    [Fact]
    public void SameCell_TwoVar_MapIteration_Sums_Keys_And_Values()
    {
        using var engine = new EmittedSessionEngine();
        var result = engine.Evaluate("""
            var m = map[int32, int32]{1: 10, 2: 20}
            var total = 0
            for k, v in m {
                total = total + k * 100 + v
            }
            total
            """);

        Assert.False(result.HasError, string.Join("; ", result.Diagnostics));
        Assert.Equal(330, result.Value);
    }

    [Fact]
    public void SameCell_OneVar_MapIteration_Yields_KeyValuePair()
    {
        using var engine = new EmittedSessionEngine();
        var result = engine.Evaluate("""
            var m = map[string, int32]{"a": 1, "bb": 2}
            var total = 0
            for kv in m {
                total = total + kv.Key.Length * kv.Value
            }
            total
            """);

        Assert.False(result.HasError, string.Join("; ", result.Diagnostics));
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void CrossCell_TwoVar_Iterates_PriorCell_Map_Global()
    {
        using var engine = new EmittedSessionEngine();

        var declare = engine.Evaluate("""
            var scores = map[string, int32]{"a": 1, "b": 2, "c": 3}
            """);
        Assert.False(declare.HasError, string.Join("; ", declare.Diagnostics));

        var iterate = engine.Evaluate("""
            var sum = 0
            for name, score in scores {
                sum = sum + score
            }
            sum
            """);

        Assert.False(iterate.HasError, string.Join("; ", iterate.Diagnostics));
        Assert.Equal(6, iterate.Value);
    }

    [Fact]
    public void CrossCell_OneVar_Iterates_PriorCell_Map_Global()
    {
        using var engine = new EmittedSessionEngine();

        var declare = engine.Evaluate("""
            var m = map[int32, string]{7: "abc", 8: "d"}
            """);
        Assert.False(declare.HasError, string.Join("; ", declare.Diagnostics));

        var iterate = engine.Evaluate("""
            var n = 0
            for kv in m {
                n = n + kv.Key + kv.Value.Length
            }
            n
            """);

        Assert.False(iterate.HasError, string.Join("; ", iterate.Diagnostics));
        Assert.Equal(19, iterate.Value);
    }

    [Fact]
    public void CrossCell_MapMutated_In_Between_Iterates_Current_State()
    {
        using var engine = new EmittedSessionEngine();

        var declare = engine.Evaluate("""
            var m = map[string, int32]{"a": 1}
            """);
        Assert.False(declare.HasError, string.Join("; ", declare.Diagnostics));

        var mutate = engine.Evaluate("""
            m["b"] = 41
            """);
        Assert.False(mutate.HasError, string.Join("; ", mutate.Diagnostics));

        var iterate = engine.Evaluate("""
            var sum = 0
            for k, v in m {
                sum = sum + v
            }
            sum
            """);

        Assert.False(iterate.HasError, string.Join("; ", iterate.Diagnostics));
        Assert.Equal(42, iterate.Value);
    }
}
