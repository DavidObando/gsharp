// <copyright file="Issue3034NullableNarrowingDiagnosticEmittedOracleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #3034: Emitted-oracle coverage for nullable narrowing diagnostic.
/// </summary>
public class Issue3034NullableNarrowingDiagnosticEmittedOracleTests
{
    private const string NullableReceiverMessage =
        "Cannot call function M because receiver 'c' may be nil. Use '?.' for a null-safe call or bind it with 'if let'.";

    [Theory]
    [InlineData("function", "M()", NullableReceiverMessage, null)]
    [InlineData("top-level", "M()", NullableReceiverMessage, null)]
    [InlineData("function", "M()", "Cannot find function M.", "value int32")]
    [InlineData("top-level", "M()", "Cannot find function M.", "value int32")]
    [InlineData("function", "M(\"x\")", "Cannot find function M.", "value int32")]
    [InlineData("top-level", "M(\"x\")", "Cannot find function M.", "value int32")]
    public void NullableReceiverDiagnostic_MatchesCompiler(
        string scope,
        string call,
        string expectedMessage,
        string parameter = null)
    {
        var source = scope == "top-level"
            ? $$"""
                class C { func M({{parameter}}) { } }

                var c C? = nil
                c.{{call}}
                """
            : $$"""
                class C { func M({{parameter}}) { } }

                func Run() {
                    var c C? = nil
                    c.{{call}}
                }
                """;

        var evaluation = EmittedOracle.Evaluate(source);
        var diagnostic = Assert.Single(evaluation.Diagnostics.Where(diagnostic => diagnostic.Id == "GS0159"));

        Assert.Equal(expectedMessage, diagnostic.Message);
    }
}
