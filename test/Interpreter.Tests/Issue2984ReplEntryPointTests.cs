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
}
