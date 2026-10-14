// <copyright file="Issue1644BoundTreeRewriterClonePreservationEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1644 — (cref:GSharp.Core.CodeAnalysis.Binding.BoundTreeRewriter)
/// clone paths dropped properties the binder sets after construction (or via
/// an alternate constructor). Both instances are exercised end-to-end through
/// the async state-machine lowering pipeline, since `MoveNextBodyRewriter`
/// hoists locals used across an `await` into state-machine fields, which
/// forces `BoundTreeRewriter` to clone the enclosing call/assignment node:
/// - a static call dispatched on a constructed generic user type (`Box[int32].Make(n)`, #1209)
/// previously lost `StaticGenericOwnerType` on clone, mis-parenting the emitted call at a bare
/// open-generic MethodDef instead of the construction's TypeSpec;
/// - an interface static field write (`ICounter.Count = ...`, ADR-0089 / #1030) previously lost
/// `InterfaceType` on clone, because the rewriter rebuilt it via the variable-receiver constructor
/// instead of the interface-static constructor.
/// Every user type is uniquely named so the process-wide
/// `FunctionTypeSymbol` cache cannot alias across tests.
open class Issue1644BoundTreeRewriterClonePreservationEmitTests {
    @Fact
    func EndToEnd_AsyncGenericStaticCall_SurvivesLocalHoistAcrossAwait_Runs() {
        let source = `package Probe1644a
import System
import System.Threading.Tasks

class BoxA1644[T]() {
    var Value T
    shared {
        func Make(v T) BoxA1644[T] {
            var b = BoxA1644[T]()
            b.Value = v
            return b
        }
    }
}

async func MakeAsync(n int32) int32 {
    await Task.Delay(1)
    let b = BoxA1644[int32].Make(n)
    return b.Value
}

func Main() {
    let result = MakeAsync(7).Result
    Console.WriteLine(result)
}`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_AsyncInterfaceStaticFieldWrite_SurvivesLocalHoistAcrossAwait_Runs() {
        let source = `package Probe1644b
import System
import System.Threading.Tasks

interface ICounterB1644 {
    shared {
        var Count int32
    }
}

async func BumpAsync(n int32) {
    await Task.Delay(1)
    ICounterB1644.Count = ICounterB1644.Count + n
}

func Main() {
    BumpAsync(5).Wait()
    BumpAsync(3).Wait()
    Console.WriteLine(ICounterB1644.Count)
}`
        let output = CompileAndRun(source)
        Assert.Equal("8${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1644_exe_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let stdoutWriter = StringWriter()
                using let stderrWriter = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(stdoutWriter)
                Console.SetError(stderrWriter)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
                IlVerifier.Verify(dllPath)
                let rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json")
                if !File.Exists(rtConfig) {
                    File.WriteAllText(rtConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                }
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(rtConfig)
                psi.ArgumentList.Add(dllPath)
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
                } catch { }
            }
        }
    }
}
