// <copyright file="Issue2984ReplEntryPointTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2984: interactive declarations do not execute a script entry point.
/// A second test (<c>ScriptEntryPointRunsOnlyOnDeclaringSubmission</c>) was
/// deleted in ADR-0156 Phase 3c (#3176): it exercised the evaluator
/// SessionEngine's script-mode <c>RunEntryPoint</c> switch, which retired with
/// that engine; script-mode entry-point behavior is covered by
/// <see cref="Issue2984MainEntryPointInterpreterTests"/> (EmittedProgramHost).
/// </summary>
[Collection("ConsoleIo")]
public class Issue2984ReplEntryPointTests
{
    [Fact]
    public void DeclarationOnlySubmissionsDoNotRunMain()
    {
        using var engine = new EmittedSessionEngine { CaptureConsole = true };

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
