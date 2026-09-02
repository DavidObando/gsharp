// <copyright file="Issue3310MagicTypeZeroValueReplTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #3310 / ADR-0159 (closes #2262): sound empty-instance zero values
/// through the session engine. The cross-cell arms mirror #2262's original
/// REPL scenario exactly — a bare <c>var numbers map[int, long]</c> cell
/// followed by an indexed-assignment loop cell NRE'd (GS9999) on main.
/// Nil comparison for the newly joined kinds is exercised cross-cell too.
/// </summary>
public sealed class Issue3310MagicTypeZeroValueReplTests
{
    [Fact]
    public void CrossCell_Issue2262Scenario_BareMapThenLoopAssign()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, "var numbers map[int, long]");
        AssertOk(engine, """
            for var i = 1; i <= 20; i++ {
                numbers[i] = long(i * i)
            }
            """);

        var probe = engine.Evaluate("numbers[20]");
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics));
        Assert.Equal(400L, probe.Value);
    }

    [Fact]
    public void SameCell_BareMapLocal_UsableImmediately()
    {
        using var engine = new EmittedSessionEngine();
        var result = engine.Evaluate("""
            var m map[string, int32]
            m["a"] = 1
            m["a"]
            """);

        Assert.False(result.HasError, string.Join("; ", result.Diagnostics));
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void CrossCell_BareSlice_EmptyNotNil_ThenNilCompare()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, "var xs []int32");

        var probe = engine.Evaluate("xs != nil");
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics));
        Assert.Equal(true, probe.Value);
    }

    [Fact]
    public void CrossCell_ChannelNilCompare_OnPriorCellValue()
    {
        using var engine = new EmittedSessionEngine();
        AssertOk(engine, """

            var c = chan[int32](1)
            """);

        var probe = engine.Evaluate("c != nil");
        Assert.False(probe.HasError, string.Join("; ", probe.Diagnostics));
        Assert.Equal(true, probe.Value);
    }

    [Fact]
    public void SameCell_BareSequence_IteratesAsEmpty()
    {
        using var engine = new EmittedSessionEngine();
        var result = engine.Evaluate("""
            var q sequence[int32]
            var n = 0
            for v in q {
                n = n + 1
            }

            n
            """);

        Assert.False(result.HasError, string.Join("; ", result.Diagnostics));
        Assert.Equal(0, result.Value);
    }

    private static void AssertOk(EmittedSessionEngine engine, string cell)
    {
        var result = engine.Evaluate(cell);
        Assert.False(result.HasError, $"cell '{cell}': {string.Join("; ", result.Diagnostics)}");
    }
}
