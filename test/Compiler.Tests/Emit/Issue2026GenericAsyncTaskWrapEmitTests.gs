// <copyright file="Issue2026GenericAsyncTaskWrapEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2026: calling a generic `async func` from inside another
/// generic function must observe the call's result type as `Task[U]` (the
/// substituted return type, Task-wrapped) — not the raw substituted return
/// type `U` — so `await` on the result is legal. Before this fix,
/// `gsc` reported GS0133 ("cannot be awaited") for this shape.
/// @remarks A full compile-AND-RUN round trip of the exact issue repro used to be
/// blocked by two separate, pre-existing emit-layer gaps tracked in
/// https://github.com/DavidObando/gsharp/issues/2030: (1) state-machine
/// synthesis reported GS0190 whenever the declared inner return type was an
/// open type parameter, and (2) hoisting a generic-typed parameter/local into
/// the state machine crashed at runtime with (cref:BadImageFormatException).
/// Both gaps are now fixed — these tests exercise the full compile-and-run
/// round trip rather than only pinning the binder-level GS0133 fix.
open class Issue2026GenericAsyncTaskWrapEmitTests {
    @Fact
    func GenericAsyncFunctionCall_InsideAnotherGeneric_CompilesAndRuns() {
        let source = `package P
async func Foo[U](x U) U {
    return x
}
async func Outer[U](seed U) U {
    var r = Foo(seed)
    return await r
}
var t = Outer("hi")
t.Wait()
Console.WriteLine(t.Result)`
        let output = CompileAndRun(source)
        Assert.Equal("hi${Environment.NewLine}", output)
    }

    @Fact
    func NonGenericAsyncFunctionCall_InsideGenericCaller_CompilesAndRuns() {
        // Issue #2030 gap 2 repro: a generic async caller hoisting its own
        // type-parameter-typed parameter (`seed U`) into the state machine,
        // even though the declared return type (`int32`) is concrete.
        let source = `package P
async func Answer() int32 {
    return 42
}
async func Outer[U](seed U) int32 {
    var r = Answer()
    return await r
}
var t = Outer("hi")
t.Wait()
Console.WriteLine(t.Result)`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2026_").FullName
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
                Assert.True(File.Exists(outPath), "expected emitted assembly at $outPath")
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
