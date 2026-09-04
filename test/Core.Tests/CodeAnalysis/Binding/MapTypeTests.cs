// <copyright file="MapTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Emitted-oracle coverage for map type.
/// </summary>
public class MapTypeTests
{
    [Fact]
    public void MapLiteral_StringInt_FieldAccessReturnsValue()
    {
        var source = @"
let m = map[string,int32]{""a"": 1, ""b"": 2}
m[""b""]
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void MapLiteral_IntString_LenReturnsCount()
    {
        var source = @"
let m = map[int32,string]{1: ""one"", 2: ""two"", 3: ""three""}
m.Count
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void MapIndex_MissingKey_ReturnsValueTypeZero()
    {
        var source = @"
let m = map[string,int32]{""a"": 1}
m[""missing""]
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void MapIndexAssignment_AddsOrUpdatesKey()
    {
        var source = @"
var m = map[string,int32]{""a"": 1}
m[""b""] = 2
m[""a""] = 9
m[""a""] + m[""b""]
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(11, result.Value);
    }

    [Fact]
    public void MapDelete_RemovesKey_LenDecreases()
    {
        var source = @"
var m = map[string,int32]{""a"": 1, ""b"": 2}
m.Remove(""a"")
m.Count
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void MapDelete_MissingKey_NoOp()
    {
        var source = @"
var m = map[string,int32]{""a"": 1}
m.Remove(""never_there"")
m.Count
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void MapLiteral_Empty_IsAllocated()
    {
        var source = @"
let m = map[string,int32]{}
m.Count
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void Delete_IsRetired_ReportsGS0566_NamingRemove()
    {
        // ADR-0174 D13: `delete(m, k)` is retired; the message names `m.Remove(k)`.
        var source = @"
let m = map[string,int32]{""a"": 1}
delete(m, ""a"")
";
        var result = Evaluate(source);
        var diagnostic = Assert.Single(result.Diagnostics);
        Assert.Equal("GS0566", diagnostic.Id);
        Assert.Contains("m.Remove(\"a\")", diagnostic.Message);
    }

    [Fact]
    public void MapType_TypeClause_BindsAsMapTypeSymbol()
    {
        var source = @"
var m map[string,int32] = map[string,int32]{""a"": 1}
m.Count
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    private static EmittedOracleResult Evaluate(string source)
    {
        return EmittedOracle.Evaluate(source);
    }
}
