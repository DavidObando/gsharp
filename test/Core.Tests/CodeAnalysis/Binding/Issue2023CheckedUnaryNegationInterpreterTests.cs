// <copyright file="Issue2023CheckedUnaryNegationInterpreterTests.cs" company="GSharp">
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
/// Issue #2023: interpreter counterpart of
/// <see cref="GSharp.Core.Tests.CodeAnalysis.Emit.Issue2023CheckedUnaryNegationEmitTests"/>.
/// Asserts the tree-walking evaluator agrees with the compiled/emitted IL for
/// unary negation of the each width's <c>MinValue</c> inside a
/// <c>checked</c>/<c>unchecked</c> context: overflow throws
/// <see cref="System.OverflowException"/> in a checked context and wraps
/// silently in an unchecked context (the project default per #1881), while
/// floating-point negation never traps regardless of context.
/// </summary>
public class Issue2023CheckedUnaryNegationInterpreterTests
{
    [Fact]
    public void CheckedNegation_Int32MinValue_ThrowsOverflowException()
    {
        var result = Evaluate(
            "var minInt int32 = -2147483647 - 1\n" +
            "var caught = \"no\"\n" +
            "try {\n" +
            "    var boom = checked(-minInt)\n" +
            "} catch (e OverflowException) {\n" +
            "    caught = \"yes\"\n" +
            "}\n" +
            "caught");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("yes", result.Value);
    }

    [Fact]
    public void CheckedNegation_Int64MinValue_ThrowsOverflowException()
    {
        var result = Evaluate(
            "var minLong int64 = -9223372036854775807 - 1\n" +
            "var caught = \"no\"\n" +
            "try {\n" +
            "    var boom = checked(-minLong)\n" +
            "} catch (e OverflowException) {\n" +
            "    caught = \"yes\"\n" +
            "}\n" +
            "caught");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("yes", result.Value);
    }

    [Fact]
    public void CheckedNegation_Int8MinValue_ThrowsOverflowException()
    {
        var result = Evaluate(
            "var minI8 int8 = -128\n" +
            "var caught = \"no\"\n" +
            "try {\n" +
            "    var boom = checked(-minI8)\n" +
            "} catch (e OverflowException) {\n" +
            "    caught = \"yes\"\n" +
            "}\n" +
            "caught");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("yes", result.Value);
    }

    [Fact]
    public void CheckedNegation_Int16MinValue_ThrowsOverflowException()
    {
        var result = Evaluate(
            "var minI16 int16 = -32768\n" +
            "var caught = \"no\"\n" +
            "try {\n" +
            "    var boom = checked(-minI16)\n" +
            "} catch (e OverflowException) {\n" +
            "    caught = \"yes\"\n" +
            "}\n" +
            "caught");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("yes", result.Value);
    }

    [Fact]
    public void CheckedNegation_OrdinaryValue_ReturnsNegated()
    {
        var result = Evaluate("var five int32 = 5\nchecked(-five)");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(-5, result.Value);
    }

    [Fact]
    public void UncheckedNegation_Int32MinValue_Wraps()
    {
        var result = Evaluate("var minInt int32 = -2147483647 - 1\nunchecked(-minInt)");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(-2147483648, result.Value);
    }

    [Fact]
    public void UncheckedNegation_Int64MinValue_Wraps()
    {
        var result = Evaluate("var minLong int64 = -9223372036854775807 - 1\nunchecked(-minLong)");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(long.MinValue, result.Value);
    }

    [Fact]
    public void UncheckedNegation_Int8MinValue_Wraps()
    {
        var result = Evaluate("var minI8 int8 = -128\nunchecked(-minI8)");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(sbyte.MinValue, result.Value);
    }

    [Fact]
    public void DefaultContext_NegationOfInt32MinValue_Wraps()
    {
        // Issue #1881 established unchecked as the project default when no
        // explicit checked/unchecked context is in scope; negation must match.
        var result = Evaluate("var minInt int32 = -2147483647 - 1\nvar wrapped = -minInt\nwrapped");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(-2147483648, result.Value);
    }

    [Fact]
    public void CheckedStatement_NegationOfMinValue_ThrowsOverflowException()
    {
        var result = Evaluate(
            "var caught = \"no\"\n" +
            "checked {\n" +
            "    var minInt int32 = -2147483647 - 1\n" +
            "    try {\n" +
            "        var boom = -minInt\n" +
            "    } catch (e OverflowException) {\n" +
            "        caught = \"yes\"\n" +
            "    }\n" +
            "}\n" +
            "caught");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("yes", result.Value);
    }

    [Fact]
    public void CheckedFloatNegation_NoOverflowEverOccurs()
    {
        var result = Evaluate("var big float64 = -1.7976931348623157e308\nchecked(-big)");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1.7976931348623157e308, result.Value);
    }

    [Fact]
    public void CheckedDecimalNegation_NoOverflowEverOccurs()
    {
        var result = Evaluate("var d decimal = 5.5m\nchecked(-d)");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(-5.5m, result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
