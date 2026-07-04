// <copyright file="Issue1881CheckedUncheckedInterpreterTests.cs" company="GSharp">
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
/// Issue #1881: interpreter counterpart of
/// <see cref="GSharp.Core.Tests.CodeAnalysis.Emit.Issue1881CheckedUncheckedEmitTests"/>.
/// Asserts the tree-walking evaluator agrees with the compiled/emitted IL for
/// <c>checked</c>/<c>unchecked</c> expressions and blocks: overflow throws
/// <see cref="System.OverflowException"/> (caught here via a G#-level
/// try/catch, mirroring real usage) in a checked context, and wraps silently
/// in an unchecked context (the C# project default), across signed/unsigned
/// integer widths and narrowing conversions.
/// </summary>
public class Issue1881CheckedUncheckedInterpreterTests
{
    [Fact]
    public void CheckedAddition_Int32_Overflow_ThrowsOverflowException()
    {
        var result = Evaluate(
            "var maxInt int32 = 2147483647\n" +
            "var one int32 = 1\n" +
            "var caught = \"no\"\n" +
            "try {\n" +
            "    var boom = checked(maxInt + one)\n" +
            "} catch (e OverflowException) {\n" +
            "    caught = \"yes\"\n" +
            "}\n" +
            "caught");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("yes", result.Value);
    }

    [Fact]
    public void UncheckedAddition_Int32_Overflow_Wraps()
    {
        var result = Evaluate("var maxInt int32 = 2147483647\nvar one int32 = 1\nunchecked(maxInt + one)");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(-2147483648, result.Value);
    }

    [Fact]
    public void CheckedStatement_BlockOverflow_ThrowsOverflowException()
    {
        var result = Evaluate(
            "var caught = \"no\"\n" +
            "checked {\n" +
            "    var maxInt int32 = 2147483647\n" +
            "    var one int32 = 1\n" +
            "    try {\n" +
            "        var boom = maxInt + one\n" +
            "    } catch (e OverflowException) {\n" +
            "        caught = \"yes\"\n" +
            "    }\n" +
            "}\n" +
            "caught");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("yes", result.Value);
    }

    [Fact]
    public void UncheckedStatement_BlockOverflow_Wraps()
    {
        var result = Evaluate(
            "var wrapped int32 = 0\n" +
            "unchecked {\n" +
            "    var maxInt int32 = 2147483647\n" +
            "    var one int32 = 1\n" +
            "    wrapped = maxInt + one\n" +
            "}\n" +
            "wrapped");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(-2147483648, result.Value);
    }

    [Fact]
    public void CheckedSubtraction_UInt64_Underflow_ThrowsOverflowException()
    {
        var result = Evaluate(
            "var zero uint64 = 0\n" +
            "var one uint64 = 1\n" +
            "var caught = \"no\"\n" +
            "try {\n" +
            "    var boom = checked(zero - one)\n" +
            "} catch (e OverflowException) {\n" +
            "    caught = \"yes\"\n" +
            "}\n" +
            "caught");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("yes", result.Value);
    }

    [Fact]
    public void UncheckedSubtraction_UInt64_Underflow_Wraps()
    {
        var result = Evaluate("var zero uint64 = 0\nvar one uint64 = 1\nunchecked(zero - one)");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(ulong.MaxValue, result.Value);
    }

    [Fact]
    public void CheckedMultiplication_Int64_Overflow_ThrowsOverflowException()
    {
        var result = Evaluate(
            "var big int64 = 9223372036854775807\n" +
            "var two int64 = 2\n" +
            "var caught = \"no\"\n" +
            "try {\n" +
            "    var boom = checked(big * two)\n" +
            "} catch (e OverflowException) {\n" +
            "    caught = \"yes\"\n" +
            "}\n" +
            "caught");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("yes", result.Value);
    }

    [Fact]
    public void CheckedNarrowingConversion_ByteFromInt32_Overflow_ThrowsOverflowException()
    {
        var result = Evaluate(
            "var big int32 = 300\n" +
            "var caught = \"no\"\n" +
            "try {\n" +
            "    var narrow = checked(byte(big))\n" +
            "} catch (e OverflowException) {\n" +
            "    caught = \"yes\"\n" +
            "}\n" +
            "caught");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("yes", result.Value);
    }

    [Fact]
    public void UncheckedNarrowingConversion_ByteFromInt32_Truncates()
    {
        var result = Evaluate("unchecked(byte(300))");
        Assert.Empty(result.Diagnostics);
        Assert.Equal((byte)44, result.Value);
    }

    [Fact]
    public void CheckedMultiplication_Int64_NoOverflow_MatchesEmitPrecision()
    {
        // Regression for the switch-expression "best common type" boxing bug
        // caught during development: mixed-type switch arms inside `checked(...)`
        // implicitly widened every arm to `double`, silently corrupting
        // magnitudes before the checked narrow-back — this exact shape
        // (`long(x) * long(y)` inside `checked { }`) triggered an
        // InvalidCastException at the enclosing conversion instead of the
        // correct result.
        var result = Evaluate(
            "var lz int64 = 0\n" +
            "checked {\n" +
            "    var x int32 = 1000000\n" +
            "    var y int32 = 2000\n" +
            "    lz = long(x) * long(y)\n" +
            "}\n" +
            "lz");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(2000000000L, result.Value);
    }

    [Fact]
    public void NestedContexts_InnermostUncheckedInsideChecked_Wraps()
    {
        var result = Evaluate(
            "var wrapped int32 = 0\n" +
            "checked {\n" +
            "    var maxInt int32 = 2147483647\n" +
            "    var one int32 = 1\n" +
            "    unchecked {\n" +
            "        wrapped = maxInt + one\n" +
            "    }\n" +
            "}\n" +
            "wrapped");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(-2147483648, result.Value);
    }

    [Fact]
    public void NestedContexts_InnermostCheckedInsideUnchecked_Throws()
    {
        var result = Evaluate(
            "var caught = \"no\"\n" +
            "unchecked {\n" +
            "    var maxInt int32 = 2147483647\n" +
            "    var one int32 = 1\n" +
            "    try {\n" +
            "        checked {\n" +
            "            var boom = maxInt + one\n" +
            "        }\n" +
            "    } catch (e OverflowException) {\n" +
            "        caught = \"yes\"\n" +
            "    }\n" +
            "}\n" +
            "caught");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("yes", result.Value);
    }

    [Fact]
    public void CheckedFloatMultiplication_Overflow_ProducesInfinityNotException()
    {
        var result = Evaluate("var big float64 = 1.0e308\nvar ten float64 = 10.0\nchecked(big * ten)");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(double.PositiveInfinity, result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
