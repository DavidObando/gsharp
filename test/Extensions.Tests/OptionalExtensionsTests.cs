// <copyright file="OptionalExtensionsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

// Issue #806: after the C# → G# port of `Gsharp.Extensions.Optional`,
// the emitted method signatures lose the per-parameter NullableAttribute
// metadata (only the assembly-level NullableContextAttribute(1) is
// emitted). C#'s null-flow analysis then infers a generic type
// argument that retains the receiver's nullable annotation (e.g.
// `Map<string?, _>` instead of `Map<string, _>`), which makes the
// lambda parameter appear nullable inside the body. The runtime
// semantics are unchanged — Map / FlatMap short-circuit on null
// receivers exactly like the C# original — but the C# warning trips
// CS8602. Suppress at file scope; the underlying emitter
// limitation is tracked as an Oats follow-up (per-parameter
// NullableAttribute emission for `T?` where T is a reference type).
#pragma warning disable CS8602

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

    // ----- Value-receiver overloads (where T : struct) ----------------------
    // ADR-0088 / issue #750: prior to this work the value-receiver helpers
    // carried a `*Value` suffix because the G# binder couldn't disambiguate
    // `where T : class` from `where T : struct`. The suffix is gone; the
    // tests below verify the binder picks the struct overload on a
    // Nullable<value-type> receiver and produces correct semantics.

    [Fact]
    public void Map_ValueReceiver_OnPresent_AppliesProjection()
    {
        int? value = 7;
        var result = value.Map(n => n * 2);
        Assert.Equal(14, result);
    }

    [Fact]
    public void Map_ValueReceiver_OnNull_ReturnsNull()
    {
        int? value = null;
        var result = value.Map(n => n * 2);
        Assert.Null(result);
    }

    [Fact]
    public void Map_ValueReceiver_NullProjection_Throws()
    {
        int? value = 7;
        Assert.Throws<ArgumentNullException>(() => value.Map<int, int>(null!));
    }

    [Fact]
    public void FlatMap_ValueReceiver_OnPresent_FlattensInnerNullable()
    {
        int? value = 7;
        var result = value.FlatMap(n => n > 0 ? (int?)n * 10 : null);
        Assert.Equal(70, result);
    }

    [Fact]
    public void FlatMap_ValueReceiver_OnPresent_PropagatesInnerNull()
    {
        int? value = -1;
        var result = value.FlatMap(n => n > 0 ? (int?)n * 10 : null);
        Assert.Null(result);
    }

    [Fact]
    public void FlatMap_ValueReceiver_OnNull_ReturnsNull()
    {
        int? value = null;
        var result = value.FlatMap(n => (int?)(n + 1));
        Assert.Null(result);
    }

    [Fact]
    public void OrElse_ValueReceiver_OnPresent_ReturnsValue()
    {
        int? value = 7;
        Assert.Equal(7, value.OrElse(-1));
    }

    [Fact]
    public void OrElse_ValueReceiver_OnNull_ReturnsDefault()
    {
        int? value = null;
        Assert.Equal(-1, value.OrElse(-1));
    }

    [Fact]
    public void OrCompute_ValueReceiver_OnPresent_DoesNotCallFactory()
    {
        var called = 0;
        int? value = 7;
        var result = value.OrCompute(() => { called++; return -1; });
        Assert.Equal(7, result);
        Assert.Equal(0, called);
    }

    [Fact]
    public void OrCompute_ValueReceiver_OnNull_CallsFactory()
    {
        var called = 0;
        int? value = null;
        var result = value.OrCompute(() => { called++; return 99; });
        Assert.Equal(99, result);
        Assert.Equal(1, called);
    }

    [Fact]
    public void OrThrow_ValueReceiver_OnPresent_ReturnsValue()
    {
        int? value = 7;
        Assert.Equal(7, value.OrThrow("missing"));
    }

    [Fact]
    public void OrThrow_ValueReceiver_OnNull_ThrowsWithMessage()
    {
        int? value = null;
        var ex = Assert.Throws<InvalidOperationException>(() => value.OrThrow("missing"));
        Assert.Equal("missing", ex.Message);
    }

    [Fact]
    public void IfPresent_ValueReceiver_OnPresent_Invokes()
    {
        int? value = 7;
        int captured = -1;
        value.IfPresent(n => captured = n);
        Assert.Equal(7, captured);
    }

    [Fact]
    public void IfPresent_ValueReceiver_OnNull_DoesNothing()
    {
        int? value = null;
        var called = false;
        value.IfPresent(_ => called = true);
        Assert.False(called);
    }

    [Fact]
    public void Filter_ValueReceiver_PredicateTrue_ReturnsValue()
    {
        int? value = 7;
        Assert.Equal(7, value.Filter(n => n > 0));
    }

    [Fact]
    public void Filter_ValueReceiver_PredicateFalse_ReturnsNull()
    {
        int? value = -1;
        Assert.Null(value.Filter(n => n > 0));
    }

    [Fact]
    public void Filter_ValueReceiver_OnNull_ReturnsNull()
    {
        int? value = null;
        Assert.Null(value.Filter(n => n > 0));
    }
}
