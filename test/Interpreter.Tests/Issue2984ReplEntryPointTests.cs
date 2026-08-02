// <copyright file="Issue2984ReplEntryPointTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2984: interactive declarations do not execute a script entry point.
/// </summary>
[Collection("ConsoleIo")]
public class Issue2984ReplEntryPointTests
{
    [Fact]
    public void DeclarationOnlySubmissionsDoNotRunMain()
    {
        var engine = new SessionEngine { CaptureConsole = true };

        var mainDeclaration = engine.Evaluate(
            """
            import System

            func Main() {
                Console.WriteLine("main")
            }
            """);
        var nextDeclaration = engine.Evaluate("func Helper() { }");

        Assert.False(mainDeclaration.HasError);
        Assert.False(nextDeclaration.HasError);
        Assert.Equal(
            (string.Empty, string.Empty),
            (mainDeclaration.Output, nextDeclaration.Output));
    }

    [Fact]
    public void ScriptEntryPointRunsOnlyOnDeclaringSubmission()
    {
        var engine = new SessionEngine { CaptureConsole = true, RunEntryPoint = true };

        var mainDeclaration = engine.Evaluate(
            """
            import System

            func Main() int32 {
                Console.WriteLine("main-once")
                return 7
            }
            """);
        var nextDeclaration = engine.Evaluate("func Helper() { }");
        var nextExpression = engine.Evaluate("40 + 2");

        Assert.False(mainDeclaration.HasError);
        Assert.False(nextDeclaration.HasError);
        Assert.False(nextExpression.HasError);
        Assert.Equal(7, mainDeclaration.Value);
        Assert.Null(nextDeclaration.Value);
        Assert.Null(nextExpression.Value);
        Assert.Equal("main-once\n", mainDeclaration.Output);
        Assert.Equal(
            (string.Empty, string.Empty),
            (nextDeclaration.Output, nextExpression.Output));
    }
}
