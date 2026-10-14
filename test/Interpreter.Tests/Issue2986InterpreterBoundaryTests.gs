// <copyright file="Issue2986InterpreterBoundaryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Repl
import System
import System.IO
import Xunit

/// Issue #2986: the interpreter native-call boundary (GS0514, ADR-0152) is
/// gone — every driver executes emitted code, so P/Invoke runs natively
/// everywhere. The interactive GS0514 pins that lived here drove the legacy
/// tree-walking `SessionEngine` explicitly and retired with the
/// evaluator in ADR-0156 Phase 3c (#3176); what remains is the emitted
/// script-mode proof that P/Invoke calls straight into libc.
@Collection("ConsoleIo")
open class Issue2986InterpreterBoundaryTests {
    /// ADR-0156 Phase 1: script-mode `gsi` executes emitted code, so the
    /// ADR-0152 native-call boundary (GS0514) no longer applies to file mode —
    /// the P/Invoke sample calls straight into libc and prints its golden
    /// output. GS0514 remains an interactive-REPL boundary (tests above).
    @Fact
    func BatchFileRunner_ExecutesPInvokeNatively() {
        if OperatingSystem.IsWindows() {
            // The sample targets POSIX libc; the conformance gate skips it on
            // Windows for the same reason (WindowsSkippedSamples).
            return
        }
        let pInvokePath = LocateSample("PInvoke.gs")
        let pInvoke = RunBatchFile(pInvokePath)
        Assert.Equal(0, pInvoke.ExitCode)
        Assert.Equal("13${Environment.NewLine}", pInvoke.StandardOutput.ReplaceLineEndings(Environment.NewLine))
        Assert.Equal(string.Empty, pInvoke.StandardError)
    }

    shared {
        private func RunBatchFile(path string)(ExitCode int32, StandardOutput string, StandardError string) {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                let exitCode = GSharp.Repl.Program.Main([]string{path})
                return (exitCode, stdout.ToString(), stderr.ToString())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }

        private func LocateSample(fileName string) string {
            for var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory);
                directory != nil;
                directory = directory!!.Parent {
                let path = Path.Combine(directory.FullName, "samples", fileName)
                if File.Exists(path) {
                    return path
                }
            }
            throw DirectoryNotFoundException("Could not locate samples/$fileName.")
        }
    }
}
