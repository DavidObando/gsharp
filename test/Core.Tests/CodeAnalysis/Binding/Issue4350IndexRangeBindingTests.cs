// <copyright file="Issue4350IndexRangeBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0187 / issue #4350: emitted-oracle coverage for first-class
/// <c>System.Index</c> / <c>System.Range</c> expressions and the <c>~</c>
/// one's-complement operator.
/// </summary>
public class Issue4350IndexRangeBindingTests
{
    [Fact]
    public void BareFromEnd_BindsToSystemIndexValue()
    {
        var result = EmittedOracle.Evaluate("let i = ^3\ni");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(Index.FromEnd(3), result.Value);
    }

    [Fact]
    public void ExplicitlyTypedIndexLocal_AcceptsFromEndAndIntegers()
    {
        var result = EmittedOracle.Evaluate("let a System.Index = ^2\nlet b System.Index = 4\na.Value * 10 + b.Value");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(24, result.Value);
    }

    [Fact]
    public void LeadingFromEndRange_BindsToSystemRangeValue()
    {
        var result = EmittedOracle.Evaluate("let r = ^4..^1\nr");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(new Range(Index.FromEnd(4), Index.FromEnd(1)), result.Value);
    }

    [Fact]
    public void SavedIndexBounds_BuildRange()
    {
        var result = EmittedOracle.Evaluate("let i = ^3\nlet j System.Index = 4\nlet r = i..j\nr");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(new Range(Index.FromEnd(3), 4), result.Value);
    }

    [Fact]
    public void OpenForms_UseStartAndEnd()
    {
        Assert.Equal(Range.All, EmittedOracle.Evaluate("let r = ..\nr").Value);
        Assert.Equal(Range.StartAt(Index.FromEnd(2)), EmittedOracle.Evaluate("let r = ^2..\nr").Value);
        Assert.Equal(Range.EndAt(Index.FromEnd(2)), EmittedOracle.Evaluate("let r = ..^2\nr").Value);
    }

    [Fact]
    public void SavedIndex_IndexesArray()
    {
        var result = EmittedOracle.Evaluate("var xs = [5]int32{10, 20, 30, 40, 50}\nlet i = ^2\nxs[i] + xs[(^5)]");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(50, result.Value);
    }

    [Fact]
    public void Tilde_ComplementsIntegersAndEnums()
    {
        Assert.Equal(-6, EmittedOracle.Evaluate("~5").Value);
        Assert.Equal(uint.MaxValue - 15, EmittedOracle.Evaluate("~15u").Value);
        Assert.Equal(~DayOfWeek.Sunday, EmittedOracle.Evaluate("import System\n~DayOfWeek.Sunday").Value);
    }

    [Fact]
    public void FromEndIndex_IsNotAnInteger()
    {
        // C# rejects `^a + 1` (no Index + int operator); so does G#.
        var result = EmittedOracle.Evaluate("let a = 2\nlet x = ^a + 1\nx");
        Assert.Contains(result.Diagnostics, d => d.IsError);
    }

    [Fact]
    public void RetiredGs0410_IsNeverReported()
    {
        var result = EmittedOracle.Evaluate("let r = ^1..3\nlet i = ^1\nr.Start.Value + i.Value");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0410");
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(2, result.Value);
    }
}
