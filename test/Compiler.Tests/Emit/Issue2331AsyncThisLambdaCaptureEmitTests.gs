// <copyright file="Issue2331AsyncThisLambdaCaptureEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2331: a nested lambda that captures `this` inside a
/// `Task`-returning `async func` instance method used to fail at
/// emit with GS9998 `InvalidOperationException: Variable 'this' has no
/// local slot or parameter index in the current method.`
/// @remarks Root cause:
/// (cref:Core.CodeAnalysis.Lowering.Async.AsyncStateMachineFieldMap.TryGetHoistedField)
/// is the single source of truth both the `MoveNext` body rewriter and
/// the emitter's closure-construction site (`EmitCapturedVariableLoad`
/// in `MethodBodyEmitter.Closures.cs`) rely on to decide whether a
/// captured variable resolves to a state-machine field read instead of an
/// ordinary local/parameter load. `this` is always hoisted into
/// `ThisField` for an instance-method state machine, but that lookup
/// only special-cased `this` in the private copy inside
/// `MoveNextBodyRewriter`: the public `TryGetHoistedField` consulted
/// by the emitter when constructing a captured-`this` closure did not, so the
/// closure-construction site fell back to treating the kickoff method's
/// (now-hoisted, slot-less) `ThisParameter` as an ordinary local/param
/// load and the emitter's slot lookup threw. Adding the same `this`
/// special case to the shared field map closes the gap for every caller at
/// once — including nested lambdas transitively reachable from the async
/// body — without touching the emitter's slot-lookup logic itself.
///
/// These tests exercise the five shapes called out by the issue: an
/// implicit-`this` instance call, an explicit `this.field` read, a
/// lambda that captures both `this` and an ordinary local, a doubly
/// nested lambda capturing `this`, and the exact Oahu
/// `await Task.Run(() => InstanceMethod())` shape. Non-async and
/// local-only-capture async controls are included to prove the existing
/// behavior stays green.
open class Issue2331AsyncThisLambdaCaptureEmitTests {
    @Fact
    func AsyncInstanceMethod_LambdaImplicitThisCapture_InstanceCall_Runs() {
        // Exact issue repro shape: `await Task.Run(() -> Do())` where `Do()`
        // is an implicit-`this` instance call inside the nested lambda.
        const source = `package i2331implicit
import System
import System.Threading.Tasks

class Worker() {
    async func RunAsync() -> await Task.Run(() -> Do())
    func Do() { Console.WriteLine("x") }
}

let w = Worker()
w.RunAsync().Wait()`
        let output = CompileAndRun(source)
        Assert.Equal("x${Environment.NewLine}", output)
    }

    @Fact
    func AsyncInstanceMethod_LambdaExplicitThisField_Runs() {
        const source = `package i2331explicit
import System
import System.Threading.Tasks

class Worker() {
    var Value int32 = 41
    async func RunAsync() -> await Task.Run(() -> Console.WriteLine(this.Value + 1))
}

let w = Worker()
w.RunAsync().Wait()`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func AsyncInstanceMethod_LambdaMixedThisAndLocalCapture_Runs() {
        const source = `package i2331mixed
import System
import System.Threading.Tasks

class Worker() {
    var Value int32 = 10
    async func RunAsync(extra int32) {
        let local = 5
        await Task.Run(() -> Console.WriteLine(this.Value + local + extra))
    }
}

let w = Worker()
w.RunAsync(2).Wait()`
        let output = CompileAndRun(source)
        Assert.Equal("17${Environment.NewLine}", output)
    }

    @Fact
    func AsyncInstanceMethod_DoublyNestedLambdaCapturingThis_Runs() {
        const source = `package i2331doublenested
import System
import System.Threading.Tasks

class Worker() {
    var Value int32 = 100
    async func RunAsync() {
        await Task.Run(() -> {
            let inner = () -> Console.WriteLine(this.Value)
            inner()
        })
    }
}

let w = Worker()
w.RunAsync().Wait()`
        let output = CompileAndRun(source)
        Assert.Equal("100${Environment.NewLine}", output)
    }

    @Fact
    func AsyncInstanceMethod_OahuTaskRunCleanupShape_Runs() {
        // Mirrors the real Oahu occurrence quoted in the issue:
        //   public async Task CleanupAsync() => await Task.Run(() => Cleanup());
        const source = `package i2331oahu
import System
import System.Threading.Tasks

class Resource() {
    async func CleanupAsync() -> await Task.Run(() -> Cleanup())
    func Cleanup() { Console.WriteLine("cleaned") }
}

let r = Resource()
r.CleanupAsync().Wait()`
        let output = CompileAndRun(source)
        Assert.Equal("cleaned${Environment.NewLine}", output)
    }

    @Fact
    func Control_NonAsync_LambdaCapturingThis_StillRuns() {
        // Non-regression control: the same nested-lambda-captures-this shape
        // outside of async lowering must remain unaffected by this fix.
        const source = `package i2331controlsync
import System

class Worker() {
    func Do() { Console.WriteLine("nonasync") }
    func RunSync() -> (() -> Do())()
}

let w = Worker()
w.RunSync()`
        let output = CompileAndRun(source)
        Assert.Equal("nonasync${Environment.NewLine}", output)
    }

    @Fact
    func Control_AsyncMethod_LambdaCapturingOnlyLocal_StillRuns() {
        // Non-regression control: the pre-existing working case of an async
        // method whose nested lambda captures only an ordinary local (no
        // `this` involved at all — including static/free functions).
        const source = `package i2331controllocal
import System
import System.Threading.Tasks

async func RunAsync() {
    let local = 7
    await Task.Run(() -> Console.WriteLine(local))
}

RunAsync().Wait()`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2331_exe_").FullName
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
