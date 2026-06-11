// <copyright file="DataStructTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Phase 3.B.2 — <c>data struct</c> declarations (ADR-0029). Interpreter-side
/// behaviour: structural equality, hash, ToString, and <c>==</c>/<c>!=</c>
/// operators on data-struct values. Emit-side support lands in a follow-up
/// commit.
/// </summary>
public class DataStructTests
{
    [Fact]
    public void DataStruct_EqualValues_AreEqual()
    {
        var source = @"
type Point data struct {
    var X int32
    var Y int32
}

var p = Point{X: 1, Y: 2}
var q = Point{X: 1, Y: 2}
p == q
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void DataStruct_DifferentFieldValues_AreNotEqual()
    {
        var source = @"
type Point data struct {
    var X int32
    var Y int32
}

var p = Point{X: 1, Y: 2}
var q = Point{X: 1, Y: 3}
p != q
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void DataStruct_AssignmentCreatesEqualCopy()
    {
        var source = @"
type Point data struct {
    var X int32
    var Y int32
}

var p = Point{X: 5, Y: 7}
var q = p
q.X = 99
p == q
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(false, result.Value);
    }

    [Fact]
    public void PlainStruct_EqualityRejected()
    {
        var source = @"
type Point struct {
    var X int32
    var Y int32
}

var p = Point{X: 1, Y: 2}
var q = Point{X: 1, Y: 2}
p == q
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void DataStruct_DistinctTypes_EqualityRejected()
    {
        var source = @"
type A data struct {
    var V int32
}
type B data struct {
    var V int32
}

var a = A{V: 1}
var b = B{V: 1}
a == b
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void DataStruct_NoFields_Diagnosed()
    {
        var source = @"
type Empty data struct {
}
0
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void DataStruct_ToString_IncludesFieldValues()
    {
        var source = @"
type Point data struct {
    var X int32
    var Y int32
}

var p = Point{X: 3, Y: 4}
p
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.NotNull(result.Value);
        var rendered = result.Value.ToString();
        Assert.Equal("Point(X=3, Y=4)", rendered);
    }

    [Fact]
    public void DataStruct_HashCode_StableForEqualValues()
    {
        var sym = BuildPoint(out var compilation);
        var p = new StructValue(sym);
        p.Fields["X"] = 1;
        p.Fields["Y"] = 2;
        var q = new StructValue(sym);
        q.Fields["X"] = 1;
        q.Fields["Y"] = 2;
        Assert.Equal(p.GetHashCode(), q.GetHashCode());
        Assert.True(p.Equals(q));
        _ = compilation;
    }

    [Fact]
    public void DataStruct_ExplicitEqualsObject_ReportsGS0232()
    {
        // ADR-0029 / Issue #410: Equals/GetHashCode/ToString/op_Equality/
        // op_Inequality/Deconstruct are synthesized for data structs and
        // cannot be hand-written, so the structural contract stays
        // predictable.
        var source = @"
type Point data struct {
    var X int32
    var Y int32
}

func (p Point) Equals(other any) bool {
    return false
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0232");
    }

    [Fact]
    public void DataStruct_ExplicitGetHashCode_ReportsGS0232()
    {
        var source = @"
type Point data struct {
    var X int32
    var Y int32
}

func (p Point) GetHashCode() int32 {
    return 0
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0232");
    }

    [Fact]
    public void DataStruct_ExplicitDeconstruct_ReportsGS0232()
    {
        var source = @"
type Point data struct {
    var X int32
    var Y int32
}

func (p Point) Deconstruct() {
}
0
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0232");
    }

    private static StructSymbol BuildPoint(out Compilation compilation)
    {
        var source = @"
type Point data struct {
    var X int32
    var Y int32
}
0
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        compilation = new Compilation(tree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        Assert.Empty(result.Diagnostics);
        var sym = (StructSymbol)compilation.GlobalScope.Structs.Single(s => s.Name == "Point");
        Assert.NotNull(sym);
        Assert.True(sym.IsData);
        return sym;
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
