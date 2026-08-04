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
using GSharp.Tests;
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
    public void TopLevelTernary_WithAlignmentAndFormat_Evaluates()
    {
        var result = Evaluate("""
            let ok = true
            let aligned = "[${ok ? 1 : 2,6}]"
            let formatted = "[${ok ? 1 : 2,6:D4}]"
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("[     1]", Value(result, "aligned"));
        Assert.Equal("[  0001]", Value(result, "formatted"));
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
    public void DeepNestedInterpolation_WithOuterFormat_Evaluates()
    {
        // A timing assertion would be flaky in CI. Depth 18 keeps correctness
        // coverage while making an accidental return to two parses per level
        // obvious in local interpolation-suite timings.
        var expression = "1";
        for (var i = 0; i < 18; i++)
        {
            expression = "\"${" + expression + "}\"";
        }

        var result = Evaluate("let text = \"[${" + expression + ",6:D4}]\"");

        Assert.Empty(result.Diagnostics);
        Assert.Equal("[     1]", Value(result, "text"));
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

    [Theory]
    [InlineData("let text = \"${[]int32?{1, 2, 3}.Length:D4}\"", "0003")]
    [InlineData("let text = \"${[3]int32?{1, 2, 3}.Length:D4}\"", "0003")]
    [InlineData("let text = \"${[]string?{\"a\", \"b\"}.Length:D4}\"", "0002")]
    public void NullableElementArrayLiteral_WithFormat_RemainsSupported_Guard(
        string declaration,
        string expected)
    {
        var result = Evaluate(declaration);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(expected, Value(result, "text"));
    }

    [Fact]
    public void NullableElementArrayLiteral_WithAlignment_RemainsSupported_Guard()
    {
        var result = Evaluate(
            "let text = \"[${[]int32?{1, 2, 3}.Length,6}]\"");

        Assert.Empty(result.Diagnostics);
        Assert.Equal("[     3]", Value(result, "text"));
    }

    private static (ImmutableArray<Diagnostic> Diagnostics, IReadOnlyDictionary<string, object> Variables) Evaluate(string source)
    {
        // Post-run globals read back through the oracle (issue #3176 Phase
        // 3b.2): the emitted equivalent of the evaluator's variables
        // dictionary.
        var result = EmittedOracle.Evaluate(source);
        return (result.Diagnostics, result.ReadGlobals());
    }

    private static object Value(
        (ImmutableArray<Diagnostic> Diagnostics, IReadOnlyDictionary<string, object> Variables) result,
        string name) =>
        result.Variables[name];
}
