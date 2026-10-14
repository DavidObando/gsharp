// <copyright file="Issue1325StructConstraintEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1325: end-to-end emit + execution test proving that a generic method
/// with a `where T : struct` constraint resolves, binds, and emits
/// verifiable IL when the type argument is a SAME-COMPILATION user-defined
/// struct — exercised through
/// (cref:System.Runtime.InteropServices.MemoryMarshal)'s
/// `AsBytes<T>` (inferred type argument) and
/// `Cast<TFrom, TTo>` (explicit type arguments).
///
/// Before the fix the user struct was erased to a `System.Object`
/// placeholder, failing the value-type/struct constraint check, and the call
/// was rejected with `GS0159`. The emitted MethodSpec must carry the real
/// user-struct TypeDef token (not `object`) so the reinterpretation
/// computes the correct element size at runtime. This test compiles via
/// `gsc`, ilverifies (no tolerated codes — the IL must be fully
/// verifiable), and executes to assert the reinterpreted bytes/uint32 values.
open class Issue1325StructConstraintEmitTests {
    @Fact
    func UserStructSpan_MemoryMarshalAsBytesAndCast_CompilesVerifiesAndRuns() {
        const source = `package Probe
import System
import System.Runtime.InteropServices

struct E { var a int32 }

func run() {
    var arr []E = []E{E{a: int32(0x01020304)}, E{a: int32(0x05060708)}}
    var sp Span[E] = arr.AsSpan()
    var bytes = MemoryMarshal.AsBytes(sp)
    Console.WriteLine(bytes.Length)
    var u = MemoryMarshal.Cast[E, uint32](sp)
    Console.WriteLine(u.Length)
    Console.WriteLine(u[0])
    Console.WriteLine(u[1])
}

run()`
        // The reinterpretation is fully verifiable; no tolerated codes.
        let output = CompileAndRun(source, Array.Empty[string]())
        // 2 E (4 bytes each) -> 8 bytes; cast to uint32 -> 2 elements whose
        // little-endian values are the original int32 fields.
        Assert.Equal(
            "8${Environment.NewLine}2${Environment.NewLine}16909060${Environment.NewLine}84281096${Environment.NewLine}",
            output
        )
    }

    shared {
        private func CompileAndRun(source string, ilVerifyIgnored[]string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1325_").FullName
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
                IlVerifier.Verify(outPath, nil, ilVerifyIgnored)
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
