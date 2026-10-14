// <copyright file="Issue2984ReplEntryPointTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Repl.Engine
import System.Collections.Generic
import Xunit

/// Issue #2984: interactive declarations do not execute a script entry point.
/// A second test (`ScriptEntryPointRunsOnlyOnDeclaringSubmission`) was
/// deleted in ADR-0156 Phase 3c (#3176): it exercised the evaluator
/// SessionEngine's script-mode `RunEntryPoint` switch, which retired with
/// that engine; script-mode entry-point behavior is covered by
/// (cref:Issue2984MainEntryPointInterpreterTests) (EmittedProgramHost).
@Collection("ConsoleIo")
open class Issue2984ReplEntryPointTests {
    @Fact
    func DeclarationOnlySubmissionsDoNotRunMain() {
        using let engine = EmittedSessionEngine(default(IReadOnlyList[string])){CaptureConsole = true}
        let mainDeclaration = engine.Evaluate(`import System

func Main() {
    Console.WriteLine("main")
}`)
        let nextDeclaration = engine.Evaluate("func Helper() { }")
        Assert.False(mainDeclaration.HasError)
        Assert.False(nextDeclaration.HasError)
        Assert.Equal((string.Empty, string.Empty), (mainDeclaration.Output, nextDeclaration.Output))
    }
}
