// <copyright file="Issue2442ClosureCallableNarrowingEmitTests.cs" company="GSharp">
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

/// ADR-0069 amendment / issue #2442 — end-to-end compile + IL-verify + run
/// coverage for the closure-callable-narrowing fix: a nil-guard's smart-cast
/// narrowing on a read-only, plain-variable binding (a `let` local or a
/// by-value/`in` parameter) now survives into a captured lambda / local
/// function / async lambda body, and the emitted IL both verifies and
/// actually invokes the guarded delegate at runtime.
open class Issue2442ClosureCallableNarrowingEmitTests {
    @Fact
    func DownloadDecryptJobShape_NamedDelegateField_InvokesInsideTaskRunClosure() {
        let source = `package Issue2442Pkg
import System
import System.Collections.Generic
import System.Threading.Tasks

delegate ConvertFunc(data []uint8) []uint8;

class DownloadDecryptJob {
    var runningTasks List[Task] = List[Task]()

    func Convert(data []uint8, convertAction ConvertFunc?) {
        if convertAction != nil {
            runningTasks.Add(Task.Run(() -> {
                let result = convertAction(data)
                Console.WriteLine(result.Length)
            }))
        }
        for t in runningTasks {
            t.Wait()
        }
    }
}

var conv ConvertFunc = (data []uint8) -> { return []uint8{data[0] * 2} }
let job = DownloadDecryptJob()
job.Convert([]uint8{21}, conv)`
        Assert.Equal("1${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func LetParameter_NamedDelegate_InvokedInsideArrowLambda() {
        let source = `package Issue2442Pkg
import System

delegate ConvertFunc(data int32) int32;

func Run(convertAction ConvertFunc?, data int32) {
    if convertAction != nil {
        let f = () -> { Console.WriteLine(convertAction(data)) }
        f()
    }
}

var conv ConvertFunc = (x int32) -> { return x * 3 }
Run(conv, 7)`
        Assert.Equal("21${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EscapingClosure_ReturnedAndInvokedAfterDeclaringFunctionReturns() {
        let source = `package Issue2442Pkg
import System

delegate ConvertFunc(data int32) int32;

func Make(convertAction ConvertFunc?, data int32) (() -> void)? {
    if convertAction != nil {
        return () -> { Console.WriteLine(convertAction(data)) }
    }
    return nil
}

var conv ConvertFunc = (x int32) -> { return x + 1 }
let f = Make(conv, 41)
if f != nil {
    f()
}`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func AsyncLambda_InvokesAfterAwaitSuspension() {
        let source = `package Issue2442Pkg
import System
import System.Threading.Tasks

delegate ConvertFunc(data int32) int32;

func Run(convertAction ConvertFunc?, data int32) {
    if convertAction != nil {
        let task = Task.Run(async () -> {
            await Task.Delay(1)
            Console.WriteLine(convertAction(data))
        })
        task.Wait()
    }
}

var conv ConvertFunc = (x int32) -> { return x * x }
Run(conv, 6)`
        Assert.Equal("36${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func MultipleClosures_CapturingSameReadOnlyBinding_BothInvokeCorrectly() {
        let source = `package Issue2442Pkg
import System

delegate ConvertFunc(data int32) int32;

func Run(convertAction ConvertFunc?, data int32) {
    if convertAction != nil {
        let f1 = () -> { Console.WriteLine(convertAction(data)) }
        let f2 = () -> { Console.WriteLine(convertAction(data + 1)) }
        f1()
        f2()
    }
}

var conv ConvertFunc = (x int32) -> { return -x }
Run(conv, 5)`
        Assert.Equal("-5${Environment.NewLine}-6${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Path.Combine(AppContext.BaseDirectory, "Issue2442_" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(tempDir)
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
                IlVerifier.Verify(outPath)
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
