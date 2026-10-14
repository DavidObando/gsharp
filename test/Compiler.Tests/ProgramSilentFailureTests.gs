// <copyright file="ProgramSilentFailureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.IO
import System.Text.RegularExpressions
import Xunit

/// 6.2 SilentEmitFailure invariant (outer ring): asserts that the GS9998
/// diagnostic line format emitted by (cref:Program.Main) matches the
/// SDK BuildTask regex and that valid programs don't trigger it.
open class ProgramSilentFailureTests {
    @Fact
    func Main_ValidProgram_ExitsZero_NoGS9998() {
        let source = `package Test
import System

Console.WriteLine("hello")`
        let (exitCode, stdout, _) = RunCompiler(source)
        Assert.Equal(0, exitCode)
        // No GS9998 should appear for a valid program
        let lines = stdout.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries)
        for line in lines {
            let match = DiagnosticLine.Match(line.Trim())
            Assert.False(
                match.Success && match.Groups["code"].Value.Trim() == "GS9998",
                "Unexpected GS9998 in stdout: $line"
            )
        }
    }

    @Fact
    func DiagnosticLineRegex_MatchesLocatedGS9998Format() {
        let sampleLine = "/path/to/test.gs(9,5,9,16): error GS9998: InvalidOperationException: something broke"
        let match = DiagnosticLine.Match(sampleLine)
        Assert.True(match.Success, "Regex should match: $sampleLine")
        Assert.Equal("/path/to/test.gs", match.Groups["file"].Value)
        Assert.Equal("9", match.Groups["l1"].Value)
        Assert.Equal("5", match.Groups["c1"].Value)
        Assert.Equal("9", match.Groups["l2"].Value)
        Assert.Equal("16", match.Groups["c2"].Value)
        Assert.Equal("error", match.Groups["sev"].Value)
        Assert.Equal("GS9998", match.Groups["code"].Value.Trim())
        Assert.Contains("InvalidOperationException", match.Groups["msg"].Value)
    }

    @Fact
    func Main_BindingError_ProducesNonZeroExit_ButNotGS9998() {
        // A binding-time error should produce normal diagnostics, not GS9998.
        let source = `package Test
import System

var x = undefinedVar`
        let (exitCode, stdout, _) = RunCompiler(source)
        Assert.NotEqual(0, exitCode)
        let lines = stdout.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries)
        for line in lines {
            let match = DiagnosticLine.Match(line.Trim())
            if match.Success && match.Groups["code"].Value.Trim() == "GS9998" {
                Assert.Fail("Binding error should not produce GS9998: $line")
            }
        }
    }

    @Fact
    func ReportUnhandledException_DebugStackFollowsDiagnostic() {
        const EnvironmentVariable = "GS_DEBUG_STACK"
        let previousValue string? = Environment.GetEnvironmentVariable(EnvironmentVariable)
        let previousOut = Console.Out
        using let stdout = StringWriter()
        try {
            Environment.SetEnvironmentVariable(EnvironmentVariable, "1")
            Console.SetOut(stdout)
            Assert.Equal(1, Program.ReportUnhandledException(InvalidOperationException("ordering-probe")))
        } finally {
            Console.SetOut(previousOut)
            Environment.SetEnvironmentVariable(EnvironmentVariable, previousValue)
        }
        let lines = stdout.ToString().Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries)
        Assert.Contains("error GS9998: InvalidOperationException: ordering-probe", lines[0])
        Assert.StartsWith("System.InvalidOperationException: ordering-probe", lines[1])
    }

    shared {
        /// The SDK BuildTask regex for diagnostic lines.
        private let DiagnosticLine Regex = Regex(
            "^(?<file>[^(]+)\\((?<l1>\\d+),(?<c1>\\d+)(?:,(?<l2>\\d+),(?<c2>\\d+))?\\):\\s*(?<sev>error|warning|info)\\s+(?<code>[^:]+):\\s*(?<msg>.*)$$",
            RegexOptions.Compiled
        )

        private func RunCompiler(source string)(ExitCode int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_silent_failure_test_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + outPath, "/target:exe", "/nowarn:GS9100", srcPath}
                using let outWriter = StringWriter()
                using let errWriter = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(outWriter)
                Console.SetError(errWriter)
                var exitCode int32
                try {
                    exitCode = Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                return (exitCode, outWriter.ToString(), errWriter.ToString())
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
