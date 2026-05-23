// <copyright file="NullableTypeTests.cs" company="GSharp">
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
/// Phase 3.C.1 — nullable type syntax <c>T?</c> per ADR-0020.
/// </summary>
public class NullableTypeTests
{
    [Fact]
    public void Nullable_Identity_RoundTrip()
    {
        var source = @"
var x int? = 7
x
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void NullableTypeSymbol_Caches_Same_Underlying()
    {
        var a = NullableTypeSymbol.Get(TypeSymbol.Int);
        var b = NullableTypeSymbol.Get(TypeSymbol.Int);
        Assert.Same(a, b);
        Assert.Same(TypeSymbol.Int, a.UnderlyingType);
        Assert.Equal("int?", a.Name);
    }

    [Fact]
    public void NullableTypeSymbol_DoubleWrap_NoOp()
    {
        var once = NullableTypeSymbol.Get(TypeSymbol.String);
        var twice = NullableTypeSymbol.Get(once);
        Assert.Same(once, twice);
    }

    [Fact]
    public void Parser_AcceptsQuestionOnArrayElementType()
    {
        // The parser must accept `[3]int?` as a type clause (questioned element type).
        var source = @"
type X struct {
    Items [3]int?
}
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
