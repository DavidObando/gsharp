// <copyright file="Issue1701NullabilityConversionCracksEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// End-to-end regression coverage for issue #1701 crack 2
/// (`Conversion.Classify`'s nullable-open-type-parameter arm). The fix
/// blocks the implicit `T? -> object`/interface box when `T` is
/// provably a reference type: bare `class` (`HasReferenceTypeConstraint`,
/// e.g. `[T class]`) or a class-base constraint (`ClassConstraint`,
/// e.g. `[T Box]`) — the only shapes where `T?` is a genuine
/// nullable reference. An earlier revision of the fix instead gated on
/// `HasValueTypeConstraint`, which blocked every non-struct-constrained
/// shape (unconstrained, interface-constrained) and regressed issue #1455.
/// These tests assert the class-constrained crack stays closed while the
/// #1455 unconstrained/interface-constrained boxing keeps compiling and
/// running.
open class Issue1701NullabilityConversionCracksEmitTests {
    @Fact
    func ClassConstrainedNullableTypeParam_ToObject_IsBlocked() {
        // The actual #1701 crack: T is provably reference-nullable, so the
        // implicit box must be rejected rather than erasing a possibly-null
        // value into a non-null `object` slot.
        let source = "package Probe1701Block\nfunc Sink[T class](x T?) object -> x"
        let (exitCode, stderr) = TryCompile(source)
        Assert.NotEqual(0, exitCode)
        Assert.True(stderr.Contains("GS0154") || stderr.Contains("GS0155") || stderr.Contains("Cannot convert"), (`expected a null-safety diagnostic, got:
` + "$stderr"))
    }

    @Fact
    func ClassBaseConstrainedNullableTypeParam_ToObject_ReportsNullSafetyDiagnostic() {
        // Same crack, different constraint shape: a class-BASE constraint
        // (`[T Box]`) only populates `ClassConstraint`, never
        // `HasReferenceTypeConstraint` (that flag is set solely by the bare
        // `class` keyword). But `Box` being an `open class` still proves `T`
        // is a reference type, so `T?` is a genuine nullable reference here
        // too — the implicit box must be rejected exactly like `[T class]`.
        let source = `package Probe1701ClassBaseBlock
open class Box { }
func Sink[T Box](x T?) object -> x`
        let (exitCode, stderr) = TryCompile(source)
        Assert.NotEqual(0, exitCode)
        Assert.True(stderr.Contains("GS0154") || stderr.Contains("GS0155") || stderr.Contains("Cannot convert"), (`expected a null-safety diagnostic, got:
` + "$stderr"))
    }

    @Fact
    func InterfaceConstrainedNullableTypeParam_ToInterface_BoxesAndRuns() {
        // #1455 guard: interface-only constraint is not provably
        // reference-nullable (a struct can implement the interface), so this
        // must NOT be blocked.
        let source = `package Probe1701Iface
import System

open class Holder[T IComparable] {
    private var value T
    init(v T) { this.value = v }
    func GetMaybe() T? -> this.value
    func AsComparable() IComparable -> GetMaybe()
}

func Main() {
    let h = Holder[int32](3)
    Console.WriteLine(h.AsComparable()!!.CompareTo(3).ToString()!!)
}`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}", output)
    }

    @Fact
    func UnconstrainedNullableTypeParam_InstantiatedWithStruct_ArgumentToObject_BoxesAndRuns() {
        // #1455 guard: an unconstrained T's `!!T` box works for both struct
        // and reference instantiations. Argument-position case with a struct
        // instantiation must not be blocked.
        let source = `package Probe1701Unconstrained
import System
import System.Collections.Generic

open class Holder[T] {
    private var value T
    init(v T) { this.value = v }
    func GetMaybe() T? { return this.value }
    func Stash() List[object] {
        let lst = List[object]()
        lst.Add(GetMaybe())
        return lst
    }
}

func Main() {
    let h = Holder[int32](11)
    Console.WriteLine(h.Stash()[0]!!.ToString()!!)
}`
        let output = CompileAndRun(source)
        Assert.Equal("11${Environment.NewLine}", output)
    }

    shared {
        private func TryCompile(source string)(ExitCode int32, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_1701_compile_").FullName
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
                return (compileExit, stdoutWriter.ToString() + stderrWriter.ToString())
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1701_exe_").FullName
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
