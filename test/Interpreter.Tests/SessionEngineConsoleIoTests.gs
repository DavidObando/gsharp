// <copyright file="SessionEngineConsoleIoTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Repl.Engine
import System.Collections.Generic
import Xunit

/// Verifies that the REPL session engine (the emitted submission-chaining
/// engine since ADR-0156 Phase 3c, #3176) captures standard output/error and
/// can source standard input, so the interactive gsi shell can surface them in
/// the transcript.
@Collection("ConsoleIo")
open class SessionEngineConsoleIoTests {
    @Fact
    func CaptureConsole_WriteLine_IsCapturedInCell() {
        using let engine = EmittedSessionEngine(default(IReadOnlyList[string])){CaptureConsole = true}
        let cell = engine.Evaluate("Console.WriteLine(\"hello\")")
        Assert.False(cell.HasError)
        Assert.Contains("hello", cell.Output)
        Assert.Equal(string.Empty, cell.StandardError)
    }

    @Fact
    func CaptureConsole_Disabled_LeavesOutputEmpty() {
        using let engine = EmittedSessionEngine(default(IReadOnlyList[string])){CaptureConsole = false}
        let cell = engine.Evaluate("1 + 1")
        Assert.False(cell.HasError)
        Assert.Equal(string.Empty, cell.Output)
    }

    @Fact
    func CaptureConsole_Error_IsCapturedSeparately() {
        using let engine = EmittedSessionEngine(default(IReadOnlyList[string])){CaptureConsole = true}
        let cell = engine.Evaluate("Console.Error.WriteLine(\"oops\")")
        Assert.False(cell.HasError)
        Assert.Contains("oops", cell.StandardError)
    }

    @Fact
    func InputProvider_ReadLine_FeedsStandardInput() {
        using let engine = EmittedSessionEngine(default(IReadOnlyList[string])){
            CaptureConsole = true,
            InputProvider = () -> "world"
        }
        let cell = engine.Evaluate("Console.WriteLine(Console.ReadLine())")
        Assert.False(cell.HasError)
        Assert.Contains("world", cell.Output)
    }
}

@CollectionDefinition("ConsoleIo", DisableParallelization = true)
open class ConsoleIoCollection { }
