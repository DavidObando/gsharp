// <copyright file="Issue2856InterpolationTernaryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>Issue #2856: top-level ternaries inside interpolation holes.</summary>
public class Issue2856InterpolationTernaryTests
{
    [Fact]
    public void TopLevelTernary_Evaluates()
    {
        var result = Evaluate("""
            let ok = true
            let text = "${ok ? 1 : 2}"
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("1", Value(result, "text"));
    }

    [Fact]
    public void TopLevelTernary_WithFormatSpecifier_Evaluates()
    {
        var result = Evaluate("""
            let ok = true
            let text = "${ok ? 1 : 2:D4}"
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("0001", Value(result, "text"));
    }

    [Fact]
    public void NestedTopLevelTernaries_Evaluate()
    {
        var result = Evaluate("""
            let first = true
            let second = false
            let text = "${first ? second ? 1 : 2 : 3}"
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("2", Value(result, "text"));
    }

    [Fact]
    public void TopLevelTernary_WithNestedInterpolation_Evaluates()
    {
        var result = Evaluate("""
            let ok = true
            let text = "${ok ? "nested=${1}" : "no"}"
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("nested=1", Value(result, "text"));
    }

    [Fact]
    public void TopLevelTernary_IgnoresConditionalPunctuationInComments()
    {
        var result = Evaluate("""
            let ok = true
            let text = "${ok /* ? : */ ? 1 : 2}"
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("1", Value(result, "text"));
    }

    [Theory]
    [InlineData("let text = \"${maybe ?? false ? 1 : 2}\"")]
    [InlineData("let text = \"${node?.Ready ? 1 : 2}\"")]
    [InlineData("let text = \"${items?[0] != nil ? 1 : 2}\"")]
    public void QuestionPrefixedOperators_DoNotOpenTernaries(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));

        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void MapLiteralInsideTopLevelTernary_Parses()
    {
        var tree = SyntaxTree.Parse(SourceText.From(
            "let text = \"${ok ? map[string,int32]{\"a\": 1}[\"a\"] : 2}\""));

        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void PlainFormatSpecifier_RemainsSupported_Guard()
    {
        var result = Evaluate("""
            let value = 42
            let text = "${value:D4}"
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("0042", Value(result, "text"));
    }

    [Fact]
    public void ParenthesizedTernary_RemainsSupported_Guard()
    {
        var result = Evaluate("""
            let ok = true
            let text = "${(ok ? 1 : 2)}"
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("1", Value(result, "text"));
    }

    [Fact]
    public void NamedArgumentColonInsideHole_RemainsExpression_Guard()
    {
        var result = Evaluate("""
            func identity(value int32) int32 -> value
            let text = "${identity(value: 7)}"
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("7", Value(result, "text"));
    }

    [Fact]
    public void RangeInsideIndexBrackets_RemainsExpression_Guard()
    {
        var tree = SyntaxTree.Parse(SourceText.From(
            "let text = \"${values[1..3]}\""));

        Assert.Empty(tree.Diagnostics);
    }

    private static (ImmutableArray<Diagnostic> Diagnostics, Dictionary<VariableSymbol, object> Variables) Evaluate(string source)
    {
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        var variables = new Dictionary<VariableSymbol, object>();
        var result = compilation.Evaluate(variables);
        return (result.Diagnostics, variables);
    }

    private static object Value(
        (ImmutableArray<Diagnostic> Diagnostics, Dictionary<VariableSymbol, object> Variables) result,
        string name) =>
        result.Variables.Single(pair => pair.Key.Name == name).Value;
}
