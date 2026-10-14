// <copyright file="Issue2465SpanFromEndIndexEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// End-to-end compile, ILVerify, and runtime coverage for issue #2465.
open class Issue2465SpanFromEndIndexEmitTests {
    @Fact
    func SpanFromEnd_ReadWriteCompoundAndSystemIndex_IlVerifiesAndRuns() {
        const Source = `package Issue2465Compiler
import System

func Run(values []int32) int32 {
    var span Span[int32] = values
    let last = Index(1, true)
    span[^1] = span[last] + 7
    span[^2] += 10
    span[^3]++
    return span[0] * 1000 + span[1] * 100 + span[2] * 10 + span[3]
}

Console.WriteLine(Run([]int32{ 1, 2, 3, 4 }))`
        let workDir = Path.Combine(
            Environment.CurrentDirectory,
            "out",
            "test-artifacts",
            "issue2465-" + Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(workDir)
        try {
            let sourcePath = Path.Combine(workDir, "test.gs")
            let assemblyPath = Path.Combine(workDir, "test.dll")
            File.WriteAllText(sourcePath, Source)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let originalOut = Console.Out
            let originalErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var exitCode int32
            try {
                exitCode = Program.Main(
                    []string{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                )
            } finally {
                Console.SetOut(originalOut)
                Console.SetError(originalErr)
            }
            Assert.True(exitCode == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            IlVerifier.Verify(assemblyPath)
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = workDir
            }
            startInfo.ArgumentList.Add("exec")
            startInfo.ArgumentList.Add("--runtimeconfig")
            startInfo.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"))
            startInfo.ArgumentList.Add(assemblyPath)
            using let process = Process.Start(startInfo) ??
                throw InvalidOperationException("Failed to start dotnet exec.")
            let stdout = process.StandardOutput.ReadToEnd()
            let stderr = process.StandardError.ReadToEnd()
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.")
            Assert.True(process.ExitCode == 0, (`dotnet exec failed (` + "${process.ExitCode}" + `):
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            Assert.Equal("1441${Environment.NewLine}", stdout.ReplaceLineEndings(Environment.NewLine))
        } finally {
            try {
                Directory.Delete(workDir, recursive: true)
            } catch { }
        }
    }
}
