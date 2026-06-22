// <copyright file="UserOperatorTests.cs" company="GSharp">
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
/// Stream D — user-defined operator overloads on GSharp struct types via the
/// <c>func (a T) operator +(...)</c> receiver-form syntax.
/// </summary>
public class UserOperatorTests
{
    [Fact]
    public void StructPlusOperator_BinaryAddition_BindsAndEvaluates()
    {
        var source = @"
struct Vector2 {
    var X int32
    var Y int32
}

func (a Vector2) operator +(b Vector2) Vector2 {
    return Vector2{X: a.X + b.X, Y: a.Y + b.Y}
}

var p = Vector2{X: 1, Y: 2}
var q = Vector2{X: 3, Y: 4}
var r = p + q
var first = r.X
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(4, result.Value);
    }

    [Fact]
    public void StructUnaryNegation_BindsAndEvaluates()
    {
        var source = @"
struct Vector2 {
    var X int32
    var Y int32
}

func (a Vector2) operator -() Vector2 {
    return Vector2{X: -a.X, Y: -a.Y}
}

var p = Vector2{X: 3, Y: 4}
var r = -p
var negX = r.X
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(-3, result.Value);
    }

    [Fact]
    public void StructEqualityOperator_OverridesDefault()
    {
        // Two Vector2 values whose X+Y sums match should compare equal under a
        // user-defined op_Equality even when individual fields differ.
        var source = @"
struct Vector2 {
    var X int32
    var Y int32
}

func (a Vector2) operator ==(b Vector2) bool {
    return a.X + a.Y == b.X + b.Y
}

func (a Vector2) operator !=(b Vector2) bool {
    return a.X + a.Y != b.X + b.Y
}

var p = Vector2{X: 1, Y: 4}
var q = Vector2{X: 2, Y: 3}
var eq = p == q
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void InheritedBinaryOperator_DeclaredOnOpenBase_BindsThroughDerived()
    {
        // ADR-0112 A8: a user operator declared on an open base class must be
        // found when the operands are a derived instance — the binder walks the
        // base chain via TypeMemberModel.TryGetMethodIncludingInherited.
        var source = @"
open class OpBaseVec {
    var X int32
}

func (a OpBaseVec) operator +(b OpBaseVec) int32 {
    return a.X + b.X
}

class OpDerivedVec : OpBaseVec {
}

var p = OpDerivedVec{X: 5}
var q = OpDerivedVec{X: 7}
var sum = p + q
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(12, result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
