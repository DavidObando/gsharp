// <copyright file="DataStructErgonomicsTests.cs" company="GSharp">
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
/// Phase 7.3 — data-struct copy, with-expression, and deconstruction ergonomics.
/// </summary>
public class DataStructErgonomicsTests
{
    [Fact]
    public void Copy_NoOverrides_YieldsEqualValue()
    {
        var result = Evaluate(PointPrelude + @"
let p = Point{x: 1, y: 2}
let q = p.copy()
p == q
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void Copy_OneOverride_ReplacesOneField()
    {
        var result = Evaluate(PointPrelude + @"
let p = Point{x: 1, y: 2}
let q = p.copy(x = 10)
q.x + q.y
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(12, result.Value);
    }

    [Fact]
    public void Copy_AllOverrides_ReplacesAllFields()
    {
        var result = Evaluate(PointPrelude + @"
let p = Point{x: 1, y: 2}
let q = p.copy(x = 10, y = 20)
q.x + q.y
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(30, result.Value);
    }

    [Fact]
    public void With_OneOverride_MatchesCopySemantics()
    {
        var result = Evaluate(PointPrelude + @"
let p = Point{x: 1, y: 2}
let q = p.copy(x = 10)
let r = p with { x = 10 }
q == r
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void With_NonDataStruct_Diagnosed()
    {
        var result = Evaluate(@"
type Point struct {
    x int32
    y int32
}
let p = Point{x: 1, y: 2}
p with { x = 10 }
");
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void Copy_NonDataStruct_Diagnosed()
    {
        var result = Evaluate(@"
type Point struct {
    x int32
    y int32
}
let p = Point{x: 1, y: 2}
p.copy(x = 10)
");
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void PositionalDeconstruction_BindsFieldsInDeclarationOrder()
    {
        var result = Evaluate(PointPrelude + @"
let p = Point{x: 3, y: 4}
let (a, b) = p
a * 10 + b
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(34, result.Value);
    }

    [Fact]
    public void NamedDeconstruction_BindsFieldsByName()
    {
        var result = Evaluate(PointPrelude + @"
let p = Point{x: 3, y: 4}
let { x = a, y = b } = p
a * 10 + b
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(34, result.Value);
    }

    [Fact]
    public void NamedDeconstruction_ReorderedNames_BindByName()
    {
        var result = Evaluate(PointPrelude + @"
let p = Point{x: 3, y: 4}
let { y = first, x = second } = p
first * 10 + second
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(43, result.Value);
    }

    [Fact]
    public void NamedDeconstruction_UnknownField_Diagnosed()
    {
        var result = Evaluate(PointPrelude + @"
let p = Point{x: 3, y: 4}
let { z = a } = p
a
");
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void NamedDeconstruction_DuplicateField_Diagnosed()
    {
        var result = Evaluate(PointPrelude + @"
let p = Point{x: 3, y: 4}
let { x = a, x = b } = p
a
");
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void PositionalDeconstruction_WrongArity_Diagnosed()
    {
        var result = Evaluate(PointPrelude + @"
let p = Point{x: 3, y: 4}
let (a) = p
a
");
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void Copy_ReceiverWithSideEffect_EvaluatesOnce()
    {
        var result = Evaluate(PointPrelude + @"
var hits = 0
func make() Point {
    hits = hits + 1
    return Point{x: hits, y: 2}
}
let q = make().copy(x = 10)
hits
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void With_ReceiverWithSideEffect_EvaluatesOnce()
    {
        var result = Evaluate(PointPrelude + @"
var hits = 0
func make() Point {
    hits = hits + 1
    return Point{x: hits, y: 2}
}
let q = make() with { x = 10 }
hits
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    private const string PointPrelude = @"
type Point data struct {
    x int32
    y int32
}
";

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
