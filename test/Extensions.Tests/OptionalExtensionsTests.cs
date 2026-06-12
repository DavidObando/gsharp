// <copyright file="OptionalExtensionsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Gsharp.Extensions.Optional;
using Xunit;

namespace GSharp.Extensions.Tests;

/// <summary>
/// Coverage for every public symbol in <see cref="OptionalExtensions"/>
/// (reference-typed nullable receivers). Each helper is exercised on the
/// present-value path, the null path, and any documented edge.
/// </summary>
public class OptionalExtensionsTests
{
    [Fact]
    public void Map_OnPresent_AppliesProjection()
    {
        string? value = "abc";
        var result = value.Map(s => s.ToUpper());
        Assert.Equal("ABC", result);
    }

    [Fact]
    public void Map_OnNull_ReturnsNull()
    {
        string? value = null;
        var result = value.Map(s => s.ToUpper());
        Assert.Null(result);
    }

    [Fact]
    public void Map_NullProjection_Throws()
    {
        string? value = "abc";
        Assert.Throws<ArgumentNullException>(() => value.Map<string, string>(null!));
    }

    [Fact]
    public void FlatMap_OnPresent_FlattensInnerNullable()
    {
        string? value = "hello";
        var result = value.FlatMap(s => s.Length > 0 ? s.Substring(0, 1) : null);
        Assert.Equal("h", result);
    }

    [Fact]
    public void FlatMap_OnPresent_PropagatesInnerNull()
    {
        string? value = "";
        var result = value.FlatMap(s => s.Length > 0 ? s.Substring(0, 1) : null);
        Assert.Null(result);
    }

    [Fact]
    public void FlatMap_OnNull_ReturnsNull()
    {
        string? value = null;
        var result = value.FlatMap(s => s.ToUpper());
        Assert.Null(result);
    }

    [Fact]
    public void OrElse_OnPresent_ReturnsValue()
    {
        string? value = "x";
        Assert.Equal("x", value.OrElse("default"));
    }

    [Fact]
    public void OrElse_OnNull_ReturnsDefault()
    {
        string? value = null;
        Assert.Equal("default", value.OrElse("default"));
    }

    [Fact]
    public void OrElse_NullDefault_ReturnsNullWhenAbsent()
    {
        string? value = null;
        // OrElse does not validate non-null defaults — passing null is
        // legal even though the public contract recommends a non-null
        // sentinel.
        Assert.Null(value.OrElse(null!));
    }

    [Fact]
    public void OrCompute_OnPresent_DoesNotCallFactory()
    {
        var called = 0;
        string? value = "x";
        var result = value.OrCompute(() => { called++; return "default"; });
        Assert.Equal("x", result);
        Assert.Equal(0, called);
    }

    [Fact]
    public void OrCompute_OnNull_CallsFactory()
    {
        var called = 0;
        string? value = null;
        var result = value.OrCompute(() => { called++; return "default"; });
        Assert.Equal("default", result);
        Assert.Equal(1, called);
    }

    [Fact]
    public void OrThrow_OnPresent_ReturnsValue()
    {
        string? value = "x";
        Assert.Equal("x", value.OrThrow("missing"));
    }

    [Fact]
    public void OrThrow_OnNull_ThrowsWithMessage()
    {
        string? value = null;
        var ex = Assert.Throws<InvalidOperationException>(() => value.OrThrow("missing"));
        Assert.Equal("missing", ex.Message);
    }

    [Fact]
    public void IfPresent_OnPresent_Invokes()
    {
        string? value = "x";
        string? captured = null;
        value.IfPresent(s => captured = s);
        Assert.Equal("x", captured);
    }

    [Fact]
    public void IfPresent_OnNull_DoesNothing()
    {
        string? value = null;
        var called = false;
        value.IfPresent(_ => called = true);
        Assert.False(called);
    }

    [Fact]
    public void Filter_PredicateTrue_ReturnsValue()
    {
        string? value = "x";
        Assert.Equal("x", value.Filter(s => s.Length == 1));
    }

    [Fact]
    public void Filter_PredicateFalse_ReturnsNull()
    {
        string? value = "xx";
        Assert.Null(value.Filter(s => s.Length == 1));
    }

    [Fact]
    public void Filter_OnNull_ReturnsNull()
    {
        string? value = null;
        Assert.Null(value.Filter(s => s.Length == 1));
    }

    [Fact]
    public void Chain_MapFilterOrElse_ComposesNaturally()
    {
        string? input = "hello world";
        var result = input
            .Map(s => s.ToUpper())
            .Filter(s => s.Contains(' '))
            .Map(s => s.Replace(" ", "_"))
            .OrElse("<empty>");
        Assert.Equal("HELLO_WORLD", result);
    }
}
