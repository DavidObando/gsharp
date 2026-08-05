// <copyright file="SessionEngineConsoleIoTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Verifies that the REPL session engine (the emitted submission-chaining
/// engine since ADR-0156 Phase 3c, #3176) captures standard output/error and
/// can source standard input, so the interactive gsi shell can surface them in
/// the transcript.
/// </summary>
[Collection("ConsoleIo")]
public class SessionEngineConsoleIoTests
{
    [Fact]
    public void CaptureConsole_WriteLine_IsCapturedInCell()
    {
        using var engine = new EmittedSessionEngine { CaptureConsole = true };
        var cell = engine.Evaluate("Console.WriteLine(\"hello\")");

        Assert.False(cell.HasError);
        Assert.Contains("hello", cell.Output);
        Assert.Equal(string.Empty, cell.StandardError);
    }

    [Fact]
    public void CaptureConsole_Disabled_LeavesOutputEmpty()
    {
        using var engine = new EmittedSessionEngine { CaptureConsole = false };
        var cell = engine.Evaluate("1 + 1");

        Assert.False(cell.HasError);
        Assert.Equal(string.Empty, cell.Output);
    }

    [Fact]
    public void CaptureConsole_Error_IsCapturedSeparately()
    {
        using var engine = new EmittedSessionEngine { CaptureConsole = true };
        var cell = engine.Evaluate("Console.Error.WriteLine(\"oops\")");

        Assert.False(cell.HasError);
        Assert.Contains("oops", cell.StandardError);
    }

    [Fact]
    public void InputProvider_ReadLine_FeedsStandardInput()
    {
        using var engine = new EmittedSessionEngine
        {
            CaptureConsole = true,
            InputProvider = () => "world",
        };

        var cell = engine.Evaluate("Console.WriteLine(Console.ReadLine())");

        Assert.False(cell.HasError);
        Assert.Contains("world", cell.Output);
    }
}

[CollectionDefinition("ConsoleIo", DisableParallelization = true)]
public class ConsoleIoCollection
{
}
