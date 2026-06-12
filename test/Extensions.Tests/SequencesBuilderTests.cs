// <copyright file="SequencesBuilderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Gsharp.Extensions.Sequences;
using Xunit;

namespace GSharp.Extensions.Tests;

/// <summary>
/// Coverage for every static builder on <see cref="Sequences"/>.
/// </summary>
public class SequencesBuilderTests
{
    [Fact]
    public void Range_ProducesContiguousIntegers()
    {
        var result = Sequences.Range(10, 5).ToArray();
        Assert.Equal(new[] { 10, 11, 12, 13, 14 }, result);
    }

    [Fact]
    public void Range_ZeroCount_IsEmpty()
    {
        Assert.Empty(Sequences.Range(10, 0));
    }

    [Fact]
    public void Range_NegativeCount_Throws()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => Sequences.Range(0, -1).ToArray());
    }

    [Fact]
    public void RangeStep_PositiveStep_StopsBeforeEnd()
    {
        var result = Sequences.RangeStep(0, 10, 3).ToArray();
        Assert.Equal(new[] { 0, 3, 6, 9 }, result);
    }

    [Fact]
    public void RangeStep_NegativeStep_CountsDown()
    {
        var result = Sequences.RangeStep(10, 0, -3).ToArray();
        Assert.Equal(new[] { 10, 7, 4, 1 }, result);
    }

    [Fact]
    public void RangeStep_ZeroStep_Throws()
    {
        Assert.Throws<ArgumentException>(() => Sequences.RangeStep(0, 10, 0).ToArray());
    }

    [Fact]
    public void RangeStep_EmptyWhenStartPastEnd()
    {
        Assert.Empty(Sequences.RangeStep(5, 5, 1));
        Assert.Empty(Sequences.RangeStep(5, 5, -1));
    }

    [Fact]
    public void Iterate_IsInfinite_TakeBounds()
    {
        var result = Sequences.Iterate(1, n => n * 2).Take(5).ToArray();
        Assert.Equal(new[] { 1, 2, 4, 8, 16 }, result);
    }

    [Fact]
    public void Iterate_NullNext_Throws()
    {
        Assert.Throws<ArgumentNullException>(() => Sequences.Iterate<int>(0, null!).Take(1).ToArray());
    }

    [Fact]
    public void Repeat_IsInfinite_TakeBounds()
    {
        var result = Sequences.Repeat("x").Take(3).ToArray();
        Assert.Equal(new[] { "x", "x", "x" }, result);
    }

    [Fact]
    public void Of_PreservesOrder()
    {
        Assert.Equal(new[] { 1, 2, 3 }, Sequences.Of(1, 2, 3));
    }

    [Fact]
    public void Of_NoArguments_IsEmpty()
    {
        Assert.Empty(Sequences.Of<int>());
    }

    [Fact]
    public void Empty_IsEmpty()
    {
        Assert.Empty(Sequences.Empty<int>());
        Assert.Empty(Sequences.Empty<string>());
    }
}
