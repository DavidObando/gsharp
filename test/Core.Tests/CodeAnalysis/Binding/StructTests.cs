// <copyright file="StructTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Phase 3.B.1 — struct declarations, composite literals, field access.
/// Interpreter-only for now; emit support lands in a follow-up commit.
/// </summary>
public class StructTests
{
    [Fact]
    public void StructLiteral_ReadFields()
    {
        var source = @"
type Point struct {
    X int32
    Y int32
}

var p = Point{X: 3, Y: 4}
p.X + p.Y
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void StructLiteral_PartialInitDefaultsZero()
    {
        var source = @"
type Point struct {
    X int32
    Y int32
}

var p = Point{X: 5}
p.Y
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void StructLiteral_EmptyLiteralZeroes()
    {
        var source = @"
type Point struct {
    X int32
    Y int32
}

var p = Point{}
p.X + p.Y
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void StructFieldAssignment_Mutates()
    {
        var source = @"
type Point struct {
    X int32
    Y int32
}

var p = Point{X: 1, Y: 2}
p.X = 10
p.X
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(10, result.Value);
    }

    [Fact]
    public void StructAssignment_HasValueSemantics()
    {
        var source = @"
type Point struct {
    X int32
    Y int32
}

var p = Point{X: 1, Y: 2}
var q = p
q.X = 99
p.X
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void UnknownField_Diagnosed()
    {
        var source = @"
type Point struct {
    X int32
}

var p = Point{X: 1}
p.Z
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void DuplicateFieldName_Diagnosed()
    {
        var source = @"
type Point struct {
    X int32
    X int32
}
0
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void DuplicateStructName_Diagnosed()
    {
        var source = @"
type Point struct {
    X int32
}
type Point struct {
    Y int32
}
0
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
