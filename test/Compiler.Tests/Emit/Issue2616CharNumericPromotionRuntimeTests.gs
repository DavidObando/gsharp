// <copyright file="Issue2616CharNumericPromotionRuntimeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2616 end-to-end runtime and IL verification.
open class Issue2616CharNumericPromotionRuntimeTests {
    @Fact
    func PromotedCharOperations_RunWithEcmaResults() {
        const Source = `package P
import System

var a char = '5'
var b char = '1'
Console.WriteLine(a - b)
Console.WriteLine(-a)
Console.WriteLine(~b)
Console.WriteLine(a + uint32(1))

var c char = 'A'
c += 2
c ^= char(1)
Console.WriteLine(c)

var lifted char? = 'D'
lifted -= 'A'
Console.WriteLine(int32(lifted.Value))

var shifted char? = char(2)
shifted <<= char(2)
Console.WriteLine(int32(shifted.Value))`
        Assert.Equal(
            "4${Environment.NewLine}-53${Environment.NewLine}-50${Environment.NewLine}54${Environment.NewLine}B${Environment.NewLine}3${Environment.NewLine}8${Environment.NewLine}",
            CompileAndRun(Source)
        )
    }

    shared {
        private func CompileAndRun(source string) string {
            let directory = Directory.CreateTempSubdirectory("gs_issue2616_").FullName
            try {
                let sourcePath = Path.Combine(directory, "test.gs")
                let outputPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, source)
                using let stdout = StringWriter()
                using let stderr = StringWriter()
                let previousOut = Console.Out
                let previousError = Console.Error
                Console.SetOut(stdout)
                Console.SetError(stderr)
                var exitCode int32
                try {
                    exitCode = Program.Main(
                        []string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                    )
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
                Assert.True(exitCode == 0, (`gsc failed:
` + "$stdout" + `
` + "$stderr"))
                IlVerifier.Verify(outputPath)
                let startInfo = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = directory
                }
                startInfo.ArgumentList.Add("exec")
                startInfo.ArgumentList.Add("--runtimeconfig")
                startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"))
                startInfo.ArgumentList.Add(outputPath)
                using let process Process? = Process.Start(startInfo)
                let runtimeOutput = process!!.StandardOutput.ReadToEnd()
                let runtimeError = process!!.StandardError.ReadToEnd()
                Assert.True(process!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(process!!.ExitCode == 0, (`runtime failed:
` + "$runtimeOutput" + `
` + "$runtimeError"))
                return runtimeOutput.ReplaceLineEndings(Environment.NewLine)
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }
    }
}
