// <copyright file="Issue1465GenericSelfEncodingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1465 — inside the instance methods of a GENERIC class, references to
/// the class's own type parameters were mis-encoded in IL: the async/iterator
/// state-machine nested type was emitted as NON-generic, so `this`,
/// type-parameter-typed parameters, hoisted state-machine fields, and self/base
/// calls referenced a dangling `!0` (ilverify rendered `T0` /
/// `value 'T'`) instead of the class generic `ELEMENT_TYPE_VAR`. The
/// fix reifies the state-machine over ordinal-aligned copies of the enclosing
/// class's type parameters (any arity) and routes all dedicated raw-handle
/// token sites through generic-aware helpers. These tests assert the emitted IL
/// verifies clean and runs; each would fail ilverify on the pre-fix compiler.
open class Issue1465GenericSelfEncodingEmitTests {
    @Fact
    func EndToEnd_GenericClassAsyncSelfCall_VerifiesAndRuns() {
        let source = `package Probe1465a
import System
import System.Threading.Tasks

open class FilterBase1465a[T] {
    open async func AddInputAsync(input T) {
        await CompleteInternalAsync()
    }
    protected open async func CompleteInternalAsync() {
        await FlushAsync()
    }
    protected open func FlushAsync() Task {
        return Task.CompletedTask
    }
}
class AudioFilter1465a : FilterBase1465a[int32] {
}
func Main() {
    Console.WriteLine("ok")
}`
        let output = CompileAndRun(source)
        Assert.Equal("ok${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_GenericArity2ClassAsyncSelfCall_VerifiesAndRuns() {
        let source = `package Probe1465b
import System
import System.Threading.Tasks

open class Pair1465b[K, V] {
    open async func ConsumeAsync(key K, value V) {
        await ForwardAsync(key, value)
    }
    protected open async func ForwardAsync(key K, value V) {
        await DoneAsync()
    }
    protected open func DoneAsync() Task {
        return Task.CompletedTask
    }
}
class StringIntPair1465b : Pair1465b[string, int32] {
}
func Main() {
    Console.WriteLine("ok2")
}`
        let output = CompileAndRun(source)
        Assert.Equal("ok2${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_IteratorInGenericClass_VerifiesAndRuns() {
        let source = `package Probe1465d
import System
import System.Collections.Generic

open class Holder1465d[T] {
    var items []T
    func Init(a T, b T) {
        items = [2]T
        items[0] = a
        items[1] = b
    }
    open func Enumerate() sequence[T] {
        yield items[0]
        yield items[1]
    }
}
func Main() {
    var h = Holder1465d[int32]()
    h.Init(5, 9)
    for x in h.Enumerate() {
        Console.WriteLine(x)
    }
    Console.WriteLine("ok4")
}`
        let output = CompileAndRun(source)
        Assert.Equal("5${Environment.NewLine}9${Environment.NewLine}ok4${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_BaseCallIntoGenericBase_VerifiesAndRuns() {
        let source = `package Probe1465c
import System

open class FrameFilterBase1465c[T] {
    open func Dispose(disposing bool) {
        Console.WriteLine("base dispose")
    }
}
open class AavdFilterBase1465c : FrameFilterBase1465c[int32] {
}
class AavdFilter1465c : AavdFilterBase1465c {
    override func Dispose(disposing bool) {
        base.Dispose(disposing)
    }
}
func Main() {
    var f = AavdFilter1465c()
    f.Dispose(true)
    Console.WriteLine("ok3")
}`
        let output = CompileAndRun(source)
        Assert.Equal("base dispose${Environment.NewLine}ok3${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1465_exe_").FullName
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
