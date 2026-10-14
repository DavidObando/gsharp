// <copyright file="Issue1199ImportedCompositeLiteralEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1199: end-to-end emit tests proving a composite literal
/// `T{Member: value}` on an IMPORTED reference-type class (a BCL class)
/// constructs the instance via its parameterless constructor and assigns each
/// named settable member through its CLR property setter / field — the C#
/// object-initializer lowering. Each test compiles via `gsc`, runs
/// `ilverify`, executes the produced assembly, and asserts the member value
/// round-trips, which can only hold if the setter actually ran.
open class Issue1199ImportedCompositeLiteralEmitTests {
    @Fact
    func ImportedClassCompositeLiteral_SettableProperty_RoundTrips() {
        let source = `package Probe
import System
import System.Text

var sb = StringBuilder{Capacity: 128}
Console.WriteLine(sb.Capacity)`
        let output = CompileAndRun(source)
        Assert.Equal("128${Environment.NewLine}", output)
    }

    @Fact
    func ImportedClassCompositeLiteral_MultipleMembers_RoundTrip() {
        let source = `package Probe
import System
import System.Text

var sb = StringBuilder{Capacity: 64}
sb.Append("hi")
Console.WriteLine(sb.Capacity)
Console.WriteLine(sb.ToString())`
        let output = CompileAndRun(source)
        Assert.Equal("64${Environment.NewLine}hi${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1199_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath)
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch {
                    // ignored

                }
            }
        }
    }
}
