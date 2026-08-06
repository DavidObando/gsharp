// <copyright file="Issue2999TargetInvocationExceptionEmittedOracleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Reflection;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2999: Emitted-oracle coverage for target invocation exception.
/// </summary>
public class Issue2999TargetInvocationExceptionEmittedOracleTests
{
    [Fact]
    public void UserThrownTargetInvocationException_IsCatchable()
    {
        const string Source = """
            import System
            import System.Reflection

            let handler () -> int32 = () -> throw TargetInvocationException(
                "outer",
                InvalidOperationException("inner"))

            var caught = false
            try {
                handler()
            } catch (ex TargetInvocationException) {
                caught = true
            }
            caught
            """;

        var result = Evaluate(Source);

        Assert.Equal(true, result.Value);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ReflectionWrapper_UnwrapsOnlyToUserTargetInvocationException()
    {
        const string Source = """
            import System
            import System.Reflection
            import GSharp.Interpreter.Tests

            var message = ""
            try {
                Issue2999ExceptionProbe.ThrowUserTargetInvocationException()
            } catch (ex TargetInvocationException) {
                message = ex.Message
            }
            message
            """;

        var result = Evaluate(Source);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("outer", result.Value);
    }

    [Fact]
    public void ReflectionWrappedFormatException_IsCatchable()
    {
        const string Source = """
            import System

            var caught = false
            try {
                Convert.ToInt32("x")
            } catch (ex FormatException) {
                caught = true
            }
            caught
            """;

        var result = Evaluate(Source);

        Assert.Equal(true, result.Value);
        Assert.Empty(result.Diagnostics);
    }

    private static EmittedOracleResult Evaluate(string source)
        => EmittedOracle.Evaluate(source);
}

/// <summary>
/// CLR exception probes for issue #2999.
/// </summary>
public static class Issue2999ExceptionProbe
{
    /// <summary>
    /// Throws a deliberate target-invocation exception.
    /// </summary>
    /// <returns>This method never returns.</returns>
    public static int ThrowUserTargetInvocationException()
        => throw new TargetInvocationException(
            "outer",
            new InvalidOperationException("inner"));
}
