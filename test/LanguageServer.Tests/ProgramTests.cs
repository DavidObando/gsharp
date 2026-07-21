// <copyright file="ProgramTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Xunit;

namespace GSharp.LanguageServer.Tests;

public sealed class ProgramTests
{
    [Theory]
    [InlineData("--debug", true)]
    [InlineData("--DEBUG", true)]
    [InlineData("--debug=true", false)]
    [InlineData("--log", false)]
    public void ShouldWaitForDebugger_RecognizesExactFlag(string argument, bool expected)
    {
        Assert.Equal(expected, Program.ShouldWaitForDebugger(new[] { argument }));
    }

    [Theory]
    [InlineData(null, null)]
    [InlineData("", null)]
    [InlineData("  protocol.log  ", "protocol.log")]
    public void GetLogPath_UsesOptInProtocolTraceEnvironment(
        string tracePath,
        string expected)
    {
        Assert.Equal(expected, Program.GetLogPath(System.Array.Empty<string>(), tracePath));
    }

    [Fact]
    public void GetLogPath_CommandLineTakesPrecedenceOverProtocolTraceEnvironment()
    {
        Assert.Equal(
            "explicit.log",
            Program.GetLogPath(new[] { "--log=explicit.log" }, "protocol.log"));
    }
}
