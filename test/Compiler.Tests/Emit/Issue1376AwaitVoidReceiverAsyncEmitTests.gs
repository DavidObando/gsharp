// <copyright file="Issue1376AwaitVoidReceiverAsyncEmitTests.cs" company="GSharp">
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
import Xunit.Sdk

/// Issue #1376: awaiting a call to a top-level receiver-clause (extension)
/// `async func` that declares no return type (a void-result `Task`)
/// must bind and emit. Before the fix the awaited call expression was typed as
/// `void` instead of `Task`, so the surrounding `await` rejected
/// it with GS0124 ("Expression must have a value"). The root cause was twofold:
/// the extension-call binder did not widen the async return type to `Task`,
/// and `BoundTreeRewriter.RewriteCallExpression` dropped the call-site
/// return-type override when it rebuilt the call after rewriting an argument
/// (e.g. a hoisted parameter becoming a state-machine field), reverting the type
/// back to the symbol's raw `void`. These tests compile programs that await
/// a void receiver-clause async func, verify the emitted IL, and assert runtime
/// output to prove the awaits actually execute in order.
open class Issue1376AwaitVoidReceiverAsyncEmitTests {
    @Fact
    func AwaitVoidReceiverClauseAsyncFunc_FromPlainAsync_EmitsAndRuns() {
        let source = `package P
import System
import System.Threading.Tasks

async func (s string) PrintAsync() {
    await Task.Delay(1)
    Console.WriteLine(s)
}

async func RunAsync() {
    await "hello".PrintAsync()
    await "world".PrintAsync()
}

RunAsync().GetAwaiter().GetResult()`
        Assert.Equal("hello${Environment.NewLine}world${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func AwaitVoidReceiverClauseAsyncFunc_FromAnotherReceiverClauseAsync_EmitsAndRuns() {
        // The awaiting function is itself a void receiver-clause async func, and
        // it awaits another void receiver-clause async func whose call carries a
        // hoisted argument (the receiver). This exercises the RewriteCallExpression
        // return-type-preservation path on both ends.
        let source = `package P
import System
import System.Threading.Tasks

async func (s string) StepAsync(label string) {
    await Task.Delay(1)
    Console.WriteLine(label + ":" + s)
}

async func (s string) RunAsync() {
    await s.StepAsync("a")
    await s.StepAsync("b")
}

"x".RunAsync().GetAwaiter().GetResult()`
        Assert.Equal("a:x${Environment.NewLine}b:x${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func AwaitOwnedReceiverAsyncFunc_EmitsAndRuns() {
        let source = `package P
import System
import System.Threading.Tasks

class Worker {
    var Name string
}

async func (worker Worker) PrintAsync() {
    await Task.Delay(1)
    Console.WriteLine(worker.Name)
}

Worker{Name: "owned"}.PrintAsync().GetAwaiter().GetResult()`
        Assert.Equal("owned${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1376_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    srcPath
                }
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
                // (a) Static verification: the emitted IL must be valid.
                IlVerifier.Verify(outPath)
                // (b) Dynamic verification: the emitted code must execute.
                let runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json")
                File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                let psi = ProcessStartInfo("dotnet", "exec \"" + outPath + "\""){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
                using let proc = Process.Start(psi)!!
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                proc.WaitForExit()
                if proc.ExitCode != 0 {
                    throw XunitException("exited " + proc.ExitCode.ToString() + `
stdout:
` + stdout + `
stderr:
` + stderr)
                }
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
