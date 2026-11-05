// <copyright file="Issue2354ReturnNilAndSelfReturnEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2345 follow-up (deferred finding #2): end-to-end compile → IL
/// verify → run coverage for the `return nil` / `return this` generalization
/// (binder-level coverage lives in
/// `Issue2354ReturnNilAndSelfReturnTests` in Core.Tests). These tests
/// prove the fix is not merely binder-level — the emitter's parallel
/// `IsReferenceCompatible` self-instantiation-identity check (mirroring
/// `Conversion.AreSameConstructedStructIdentity`) and its
/// the nil rule of `Conversion.Classify` (the old predicate was removed by #4316)-driven `nil`
/// no-op path both produce correct, verifiable IL that runs and returns the
/// expected values.
open class Issue2354ReturnNilAndSelfReturnEmitTests {
    @Fact
    func GenericClass_ReturnThis_RoundTripsSameInstance() {
        let source = `package p
class Box[T] {
    var Value T
    init(v T) { Value = v }
    func Self() Box[T] {
        return this
    }
}
func Main() {
    var b = Box[int32](42)
    var s = b.Self()
    System.Console.WriteLine(s.Value)
}`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func GenericClass_ReturnNil_ProducesNullReference() {
        let source = `package p
class Box[T] {
    func Nothing() Box[T]? {
        return nil
    }
}
func Main() {
    var b = Box[int32]()
    var n = b.Nothing()
    System.Console.WriteLine(n == nil)
}`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func NonGenericClass_ReturnNil_ProducesNullReference() {
        let source = `package p
class Box {
    func Nothing() Box? {
        return nil
    }
}
func Main() {
    var n = Box().Nothing()
    System.Console.WriteLine(n == nil)
}`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func NestedNullableSelfType_ReturnThis_RoundTripsValue() {
        let source = `package p
class Box[T] {
    var Value T
    init(v T) { Value = v }
    func Wrapped() Box[T]? {
        return this
    }
}
func Main() {
    var b = Box[int32](7)
    var w = b.Wrapped()
    System.Console.WriteLine(w != nil)
    System.Console.WriteLine(w!!.Value)
}`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}7${Environment.NewLine}", output)
    }

    @Fact
    func PlainClass_EqualsNilAndNotEqualsNil_EvaluateCorrectly() {
        let source = `package p
class Box {
    var X int32
    init(x int32) { X = x }
}
func Guard(b Box?) bool {
    return b == nil
}
func Main() {
    var none Box? = nil
    var some = Box(1)
    System.Console.WriteLine(Guard(none))
    System.Console.WriteLine(Guard(some))
    System.Console.WriteLine(some != nil)
}`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2354_exe_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", srcPath}
                RunCompiler(args)
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

        private func RunCompiler(args[]string) {
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
        }
    }
}
