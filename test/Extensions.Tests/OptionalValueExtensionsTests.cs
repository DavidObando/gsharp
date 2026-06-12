// <copyright file="OptionalValueExtensionsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Gsharp.Extensions.Optional;
using Xunit;

namespace GSharp.Extensions.Tests;

/// <summary>
/// Coverage for every public symbol in <see cref="OptionalValueExtensions"/>
/// (value-typed nullable receivers). Mirrors
/// <see cref="OptionalExtensionsTests"/> on <c>Nullable&lt;T&gt;</c>.
/// </summary>
public class OptionalValueExtensionsTests
{
    [Fact]
    public void MapValue_OnPresent_AppliesProjection()
    {
        int? value = 7;
        var result = value.MapValue(n => n * 2);
        Assert.Equal(14, result);
    }

    [Fact]
    public void MapValue_OnNull_ReturnsNull()
    {
        int? value = null;
        var result = value.MapValue(n => n * 2);
        Assert.Null(result);
    }

    [Fact]
    public void MapValue_NullProjection_Throws()
    {
        int? value = 7;
        Assert.Throws<ArgumentNullException>(() => value.MapValue<int, int>(null!));
    }

    [Fact]
    public void FlatMapValue_OnPresent_FlattensInnerNullable()
    {
        int? value = 7;
        var result = value.FlatMapValue(n => n > 0 ? (int?)n * 10 : null);
        Assert.Equal(70, result);
    }

    [Fact]
    public void FlatMapValue_OnPresent_PropagatesInnerNull()
    {
        int? value = -1;
        var result = value.FlatMapValue(n => n > 0 ? (int?)n * 10 : null);
        Assert.Null(result);
    }

    [Fact]
    public void FlatMapValue_OnNull_ReturnsNull()
    {
        int? value = null;
        var result = value.FlatMapValue(n => (int?)(n + 1));
        Assert.Null(result);
    }

    [Fact]
    public void OrElseValue_OnPresent_ReturnsValue()
    {
        int? value = 7;
        Assert.Equal(7, value.OrElseValue(-1));
    }

    [Fact]
    public void OrElseValue_OnNull_ReturnsDefault()
    {
        int? value = null;
        Assert.Equal(-1, value.OrElseValue(-1));
    }

    [Fact]
    public void OrComputeValue_OnPresent_DoesNotCallFactory()
    {
        var called = 0;
        int? value = 7;
        var result = value.OrComputeValue(() => { called++; return -1; });
        Assert.Equal(7, result);
        Assert.Equal(0, called);
    }

    [Fact]
    public void OrComputeValue_OnNull_CallsFactory()
    {
        var called = 0;
        int? value = null;
        var result = value.OrComputeValue(() => { called++; return 99; });
        Assert.Equal(99, result);
        Assert.Equal(1, called);
    }

    [Fact]
    public void OrThrowValue_OnPresent_ReturnsValue()
    {
        int? value = 7;
        Assert.Equal(7, value.OrThrowValue("missing"));
    }

    [Fact]
    public void OrThrowValue_OnNull_ThrowsWithMessage()
    {
        int? value = null;
        var ex = Assert.Throws<InvalidOperationException>(() => value.OrThrowValue("missing"));
        Assert.Equal("missing", ex.Message);
    }

    [Fact]
    public void IfPresentValue_OnPresent_Invokes()
    {
        int? value = 7;
        int captured = -1;
        value.IfPresentValue(n => captured = n);
        Assert.Equal(7, captured);
    }

    [Fact]
    public void IfPresentValue_OnNull_DoesNothing()
    {
        int? value = null;
        var called = false;
        value.IfPresentValue(_ => called = true);
        Assert.False(called);
    }

    [Fact]
    public void FilterValue_PredicateTrue_ReturnsValue()
    {
        int? value = 7;
        Assert.Equal(7, value.FilterValue(n => n > 0));
    }

    [Fact]
    public void FilterValue_PredicateFalse_ReturnsNull()
    {
        int? value = -1;
        Assert.Null(value.FilterValue(n => n > 0));
    }

    [Fact]
    public void FilterValue_OnNull_ReturnsNull()
    {
        int? value = null;
        Assert.Null(value.FilterValue(n => n > 0));
    }
}
