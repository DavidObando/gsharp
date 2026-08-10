// <copyright file="Issue2987ByRefLikeBoundaryInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Text;
using System.Runtime.CompilerServices;
using GSharp.Tests;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2987 residue after the tree-walking evaluator retired (ADR-0156
/// Phase 3c, #3176). The GS0511 stack-only (ByRefLike) boundary existed only
/// because the evaluator invoked members through reflection; emitted
/// execution handles ByRefLike values natively (whole-program span coverage
/// lives in the SpanComprehensive conformance sample and Compiler.Tests), so
/// the refusal pins and the <c>Evaluator.FindByRefLikeSignatureType</c>
/// machinery probes were deleted with the evaluator. What survives is the
/// engine-independent positive coverage this file carried.
/// </summary>
public class Issue2987ByRefLikeBoundaryInterpreterTests
{
    [Fact]
    public void ReflectiveInterpolationHandler_RemainsSupported()
    {
        const string Source = """
            import GSharp.Interpreter.Tests

            Issue2987InterpolationProbe.Format("value is ${42} and ${43}")
            """;

        var result = EmittedOracle.Evaluate(Source);

        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal("value is 42 and 43", result.Value);
    }

    [Fact]
    public void ClrOperators_RemainSupported()
    {
        const string Source = """
            import System

            var sum = TimeSpan.FromHours(11) + TimeSpan.FromHours(22)
            var negative = -TimeSpan.FromHours(11)
            Console.WriteLine(sum.TotalHours)
            Console.WriteLine(negative.TotalHours)
            """;

        var result = EmittedOracle.Evaluate(Source);

        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal($"33{Environment.NewLine}-11{Environment.NewLine}", result.Output.ReplaceLineEndings(Environment.NewLine));
    }
}

/// <summary>Fixture for interpolated-string-handler dispatch.</summary>
[InterpolatedStringHandler]
public struct Issue2987InterpolationHandler
{
    private readonly StringBuilder builder;

    /// <summary>Initializes a new handler.</summary>
    public Issue2987InterpolationHandler(int literalLength, int formattedCount)
    {
        this.builder = new StringBuilder(literalLength + formattedCount);
    }

    /// <summary>Appends literal text.</summary>
    public readonly void AppendLiteral(string value) => this.builder.Append(value);

    /// <summary>Appends a formatted value.</summary>
    public readonly void AppendFormatted<T>(T value) => this.builder.Append(value);

    /// <inheritdoc/>
    public override readonly string ToString() => this.builder.ToString();
}

/// <summary>Consumes the handler fixture.</summary>
public static class Issue2987InterpolationProbe
{
    /// <summary>Formats a handler.</summary>
    public static string Format(Issue2987InterpolationHandler handler) => handler.ToString();
}
