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
}
