// <copyright file="ProgramTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import System
import Xunit

class ProgramTests {
    @Theory
    @InlineData("--debug", true)
    @InlineData("--DEBUG", true)
    @InlineData("--debug=true", false)
    @InlineData("--log", false)
    func ShouldWaitForDebugger_RecognizesExactFlag(argument string, expected bool) {
        Assert.Equal(expected, Program.ShouldWaitForDebugger([]string{argument}))
    }

    @Theory
    @InlineData(nil, nil)
    @InlineData("", nil)
    @InlineData("  protocol.log  ", "protocol.log")
    func GetLogPath_UsesOptInProtocolTraceEnvironment(tracePath string?, expected string?) {
        Assert.Equal(expected, Program.GetLogPath(Array.Empty[string](), tracePath))
    }

    @Fact
    func GetLogPath_CommandLineTakesPrecedenceOverProtocolTraceEnvironment() {
        Assert.Equal("explicit.log", Program.GetLogPath([]string{"--log=explicit.log"}, "protocol.log"))
    }
}
