// <copyright file="MapTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Phase 3.A.4 binding and interpretation tests for the
/// <c>map[K]V</c> type, literal, indexing, <c>len</c>, and
/// <c>delete</c>.
/// </summary>
public class MapTypeTests
{
    [Fact]
    public void MapLiteral_StringInt_FieldAccessReturnsValue()
    {
        var source = @"
let m = map[string]int32{""a"": 1, ""b"": 2}
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
let m = map[int32]string{1: ""one"", 2: ""two"", 3: ""three""}
len(m)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void MapIndex_MissingKey_ReturnsValueTypeZero()
    {
        var source = @"
let m = map[string]int32{""a"": 1}
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
var m = map[string]int32{""a"": 1}
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
var m = map[string]int32{""a"": 1, ""b"": 2}
delete(m, ""a"")
len(m)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void MapDelete_MissingKey_NoOp()
    {
        var source = @"
var m = map[string]int32{""a"": 1}
delete(m, ""never_there"")
len(m)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void MapLiteral_Empty_IsAllocated()
    {
        var source = @"
let m = map[string]int32{}
len(m)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void Delete_NonMapArgument_Diagnoses()
    {
        var source = @"
let s = []int32{1, 2, 3}
delete(s, 0)
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void Delete_WrongArgCount_Diagnoses()
    {
        var source = @"
let m = map[string]int32{""a"": 1}
delete(m)
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void MapType_TypeClause_BindsAsMapTypeSymbol()
    {
        var source = @"
var m map[string]int32 = map[string]int32{""a"": 1}
len(m)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
