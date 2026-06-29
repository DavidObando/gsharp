// <copyright file="Issue1428ConditionalNullableOrderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1428: the best-common-type of a value-producing <c>if</c>/conditional
/// expression must UNION the nullable annotation of BOTH arms regardless of arm
/// order. When a non-nullable reference arm <c>T</c> appears first and a
/// nullable arm <c>T?</c> second (both mutually reference-convertible), the
/// merged type must still be <c>T?</c> — mirroring C# where <c>cond ? e : null</c>
/// (and the reversed form) both yield <c>T?</c>.
/// </summary>
public class Issue1428ConditionalNullableOrderTests
{
    [Fact]
    public void IfExpression_NonNullThenNullableElse_UnifiesToNullable()
    {
        var scope = BindGlobalScope(@"
let s string? = ""hi""
let x = if true { ""lit"" } else { s }
");

        Assert.Empty(scope.Diagnostics);
        var x = scope.Variables.Single(v => v.Name == "x").Type;
        var nullable = Assert.IsType<NullableTypeSymbol>(x);
        Assert.Equal(TypeSymbol.String, nullable.UnderlyingType);
    }

    [Fact]
    public void IfExpression_NullableThenNonNullElse_UnifiesToNullable()
    {
        // The reversed arm order already worked before the fix; it must keep
        // yielding the same nullable result so both orders agree.
        var scope = BindGlobalScope(@"
let s string? = ""hi""
let x = if true { s } else { ""lit"" }
");

        Assert.Empty(scope.Diagnostics);
        var x = scope.Variables.Single(v => v.Name == "x").Type;
        var nullable = Assert.IsType<NullableTypeSymbol>(x);
        Assert.Equal(TypeSymbol.String, nullable.UnderlyingType);
    }

    [Fact]
    public void IfExpression_NonNullBothArms_StaysNonNull()
    {
        // Regression guard: two non-nullable reference arms must NOT be lifted.
        var scope = BindGlobalScope(@"
let a string = ""a""
let b string = ""b""
let x = if true { a } else { b }
");

        Assert.Empty(scope.Diagnostics);
        var x = scope.Variables.Single(v => v.Name == "x").Type;
        Assert.IsNotType<NullableTypeSymbol>(x);
        Assert.Equal(TypeSymbol.String, x);
    }

    [Fact]
    public void IfExpression_GenericInterfaceArm_NonNullFirst_AssignNilSucceeds()
    {
        // The issue repro: arm0 is the non-null `IEnumerator[T]` and arm1 is the
        // nullable `IEnumerator[T]?`. The unified type must be nullable so a
        // later `x = nil` assignment is legal.
        var diagnostics = Bind(@"
import System.Collections.Generic
func F[T](e IEnumerator[T]) {
    var x = if true { e } else { default(IEnumerator[T]?) }
    x = nil
}
");

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void IfExpression_GenericInterfaceArm_NullableFirst_AssignNilSucceeds()
    {
        var diagnostics = Bind(@"
import System.Collections.Generic
func F[T](e IEnumerator[T]) {
    var x = if true { default(IEnumerator[T]?) } else { e }
    x = nil
}
");

        Assert.Empty(diagnostics);
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        if (tree.Diagnostics.Any())
        {
            return tree.Diagnostics;
        }

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        if (globalScope.Diagnostics.Any())
        {
            return globalScope.Diagnostics;
        }

        var program = Binder.BindProgram(globalScope);
        return program.Diagnostics.ToImmutableArray();
    }

    private static BoundGlobalScope BindGlobalScope(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
    }
}
