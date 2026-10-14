// <copyright file="Issue2987ByRefLikeBoundaryInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import System.Runtime.CompilerServices
import System.Text
import Xunit

/// Issue #2987 residue after the tree-walking evaluator retired (ADR-0156
/// Phase 3c, #3176). The GS0511 stack-only (ByRefLike) boundary existed only
/// because the evaluator invoked members through reflection; emitted
/// execution handles ByRefLike values natively (whole-program span coverage
/// lives in the SpanComprehensive conformance sample and Compiler.Tests), so
/// the refusal pins and the `Evaluator.FindByRefLikeSignatureType`
/// machinery probes were deleted with the evaluator. What survives is the
/// engine-independent positive coverage this file carried.
open class Issue2987ByRefLikeBoundaryInterpreterTests {
    @Fact
    func ReflectiveInterpolationHandler_RemainsSupported() {
        const Source = `import GSharp.Interpreter.Tests

Issue2987InterpolationProbe.Format("value is ${42} and ${43}")`
        let result = EmittedOracle.Evaluate(Source)
        Assert.DoesNotContain(result.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
        Assert.Equal("value is 42 and 43", result.Value)
    }

    @Fact
    func ClrOperators_RemainSupported() {
        const Source = `import System

var sum = TimeSpan.FromHours(11) + TimeSpan.FromHours(22)
var negative = -TimeSpan.FromHours(11)
Console.WriteLine(sum.TotalHours)
Console.WriteLine(negative.TotalHours)`
        let result = EmittedOracle.Evaluate(Source)
        Assert.DoesNotContain(result.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
        Assert.Equal(
            "33${Environment.NewLine}-11${Environment.NewLine}",
            result.Output.ReplaceLineEndings(Environment.NewLine)
        )
    }
}

/// Fixture for interpolated-string-handler dispatch.
@InterpolatedStringHandler
struct Issue2987InterpolationHandler {
    private let builder StringBuilder

    /// Initializes a new handler.
    init(literalLength int32, formattedCount int32) {
        this.builder = StringBuilder(literalLength + formattedCount)
    }

    /// Appends literal text.
    func AppendLiteral(value string) -> this.builder.Append(value)

    /// Appends a formatted value.
    func AppendFormatted[T](value T) -> this.builder.Append(value)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func ToString() string -> this.builder.ToString()
}

/// Consumes the handler fixture.
shared class Issue2987InterpolationProbe {
    /// Formats a handler.
    func Format(handler Issue2987InterpolationHandler) string -> handler.ToString()
}
