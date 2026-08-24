// <copyright file="Issue3510DelegateDeclarationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// Issue #3510: named delegates use the standalone
/// <c>delegate Name[TParams]?(params) ReturnType? ;</c> declaration. The
/// required trailing semicolon terminates the optional return-type clause
/// (matching extern natives and interface bodiless members), fixing the
/// retired <c>type Name = delegate func(...)</c> form's greediness — a void
/// delegate used to consume whatever declaration followed it. <c>type</c>
/// itself left the reserved keyword set: erased aliases parse contextually
/// and <c>type</c> is an ordinary identifier everywhere else.
/// </summary>
public class Issue3510DelegateDeclarationTests
{
    [Fact]
    public void VoidDelegate_FollowedByDeclaration_NoLongerConsumesIt()
    {
        var source = @"
delegate Bump(ref n int32);

func Run() int32 {
    let bump Bump = func(ref n int32) {
        n = n + 1
    }
    var x = 41
    bump(ref x)
    return x
}

Run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ReturningDelegate_WithOutParameter_RoundTrips()
    {
        var source = @"
delegate TryShape(out v int32) bool;

func Run() int32 {
    let tryGet TryShape = func(out v int32) bool {
        v = 7
        return true
    }
    if tryGet(out var got) {
        return got
    }
    return 0
}

Run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void GenericPublicDelegate_Declares()
    {
        var source = @"
public delegate Mapper[T any](value T) T;

func Run() int32 {
    let twice Mapper[int32] = func(value int32) int32 {
        return value * 2
    }
    return twice(21)
}

Run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void MissingSemicolon_Reports()
    {
        var source = @"
delegate Bump(ref n int32)

func Run() int32 {
    return 1
}

Run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.IsError && d.Id == "GS0005");
    }

    [Fact]
    public void RetiredTypeDelegateSpelling_ReportsGS0535WithRecovery()
    {
        var source = @"
type Greeter = delegate func(name string)

func Run() int32 {
    return 1
}

Run()
";
        var result = EmittedOracle.Evaluate(source);
        var errors = result.Diagnostics.Where(d => d.IsError).ToList();
        var single = Assert.Single(errors);
        Assert.Equal("GS0535", single.Id);
    }

    [Fact]
    public void TypeIsAnOrdinaryIdentifierNow()
    {
        var source = @"
func Run() string {
    var type = ""works""
    return type
}

Run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal("works", result.Value);
    }

    [Fact]
    public void ErasedTypeAlias_StillParsesContextually()
    {
        var source = @"
type Count = int32

func Run() Count {
    var v Count = 42
    return v
}

Run()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(42, result.Value);
    }
}
