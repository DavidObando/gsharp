// <copyright file="Issue3247RefLocalFromEndIndexEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #3247: a ref-aliasing local over an index-from-end element access
/// (`let ref r = xs[^1]`) ICEd the emitter with GS9998 because the
/// from-end lowering wraps the element access in a
/// `BoundBlockExpression` (receiver + offset spilled into temps) and the
/// address-of path could not see through the block wrapper. The binder now
/// sinks the address-of onto the trailing element access (mirroring the
/// `return ref` path), so the prefix runs once and the alias captures
/// the element via `ldelema`. This test compiles the canonical shapes
/// from the issue, gates the output through ILVerify, and runs it.
open class Issue3247RefLocalFromEndIndexEmitTests {
    @Fact
    func LetRef_FromEndIndex_CompilesRunsAndIlVerifies() {
        let source = `package P
import System

func probe() {
    var original = []int32{10, 20, 30}
    var current = original
    let ref r = current[^1]
    current = []int32{40, 50, 60}
    r = 99
    Console.WriteLine(r)
    Console.WriteLine("${original[0]},${original[1]},${original[2]}")
    Console.WriteLine("${current[0]},${current[1]},${current[2]}")
    var k int32 = 3
    var ref s = original[^k]
    s = s + 1
    Console.WriteLine(original[0])
}

probe()`
        Assert.Equal(
            "99${Environment.NewLine}10,20,99${Environment.NewLine}40,50,60${Environment.NewLine}11${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue3247_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(
                        []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                    )
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
                using let proc Process? = Process.Start(psi)
                let stdout = proc!!.StandardOutput.ReadToEnd()
                let stderr = proc!!.StandardError.ReadToEnd()
                Assert.True(proc!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc!!.ExitCode == 0, (`exited ` + "${proc!!.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
