// <copyright file="Issue1918ValueTaskAsyncEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1918: two related gaps in `System.Threading.Tasks.ValueTask[T]`
/// support. (a) An `async func` whose return-type clause explicitly spells
/// `ValueTask[T]` / `ValueTask` (instead of the implicit-wrap bare
/// `T` / `void` form) previously failed to bind: the declared
/// `ValueTask[T]` was used, unwrapped, as the return-statement's target
/// type, so `return v * 3` reported GS0155 ("cannot convert 'int32' to
/// 'ValueTask<int32>'") followed by GS0100 ("not all code paths return a
/// value"). (b) Awaiting a directly-constructed `ValueTask[T]` ICE'd with
/// GS9998 ("NotSupportedException: Derived classes must provide an
/// implementation.") under the SDK build path (MetadataLoadContext-loaded
/// references), because the async lowering / observable-return-type machinery
/// only recognized the `Task` / `Task[T]` wrapper shapes. Both are
/// fixed by unwrapping an explicit `Task`/`ValueTask` wrapper at the
/// async declaration to its awaited result (recording which wrapper was
/// requested), and by threading that choice through the state-machine builder
/// resolution and the call-site's observable return type.
open class Issue1918ValueTaskAsyncEmitTests {
    @Fact
    func AsyncFunc_ReturningValueTaskOfT_WrapsReturnValue() {
        let source = `package P
import System
import System.Threading.Tasks

async func TripleAsync(v int32) ValueTask[int32] {
    await Task.CompletedTask
    return v * 3
}

var r = TripleAsync(5).Result
Console.WriteLine(r)`
        let output = CompileAndRun(source)
        Assert.Equal("15${Environment.NewLine}", output)
    }

    @Fact
    func AsyncFunc_ReturningBareValueTask_CompletesWithoutValue() {
        let source = `package P
import System
import System.Threading.Tasks

async func NoteAsync(label string) ValueTask {
    await Task.CompletedTask
    Console.WriteLine(label)
}

NoteAsync("done").AsTask().Wait()`
        let output = CompileAndRun(source)
        Assert.Equal("done${Environment.NewLine}", output)
    }

    @Fact
    func Await_DirectlyConstructedValueTaskOfT_ReturnsValue() {
        let source = `package P
import System
import System.Threading.Tasks

async func RunAsync() Task {
    var ready ValueTask[int32] = ValueTask[int32](5)
    var five int32 = await ready
    Console.WriteLine(five)
}

RunAsync().Wait()`
        let output = CompileAndRun(source)
        Assert.Equal("5${Environment.NewLine}", output)
    }

    @Fact
    func Await_DirectlyConstructedBareValueTask_Completes() {
        let source = `package P
import System
import System.Threading.Tasks

async func RunAsync() Task {
    var done ValueTask = ValueTask.CompletedTask
    await done
    Console.WriteLine("completed")
}

RunAsync().Wait()`
        let output = CompileAndRun(source)
        Assert.Equal("completed${Environment.NewLine}", output)
    }

    @Fact
    func AsyncFunc_ReturningValueTaskOfT_CallsRealAsyncIoLikeMethod() {
        // "I/O-like" via Task.Delay, mirroring how a real ValueTask-returning
        // async method would await a genuinely-async completion source rather
        // than an already-completed one.
        let source = `package P
import System
import System.Threading.Tasks

async func FetchAsync(v int32) ValueTask[int32] {
    await Task.Delay(1)
    return v + 1
}

var r = FetchAsync(41).Result
Console.WriteLine(r)`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1918_").FullName
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
