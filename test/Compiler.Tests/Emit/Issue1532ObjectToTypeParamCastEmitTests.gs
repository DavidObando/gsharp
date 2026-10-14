// <copyright file="Issue1532ObjectToTypeParamCastEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1532 — gsc rejected an explicit cast from `object` (or
/// `object?`) to a type parameter `T` — written `T(o)` — with
/// `GS0155: Cannot convert type 'object' to 'T'`. C# permits `(T)o`
/// for ANY type parameter (unconstrained, `class`-, `struct`-, or
/// interface/base-constrained) as an explicit reference/unboxing conversion
/// checked at runtime, lowering to `unbox.any <T>` (a checked
/// reference cast for reference `T`, an unbox for value `T`).
///
/// The fix adds an explicit conversion `object -> T` in the binder's
/// conversion classifier (regardless of the type parameter's constraints); the
/// emitter already lowered an `object`/interface → type-parameter
/// conversion to `unbox.any T`. The conversion is EXPLICIT only — an
/// implicit `object -> T` still errors — and does not disturb the
/// reverse `T -> object` erasure rule.
///
/// Every scenario round-trips gsc → PE → ilverify → dotnet exec. Each uses a
/// UNIQUE package/type name because the in-process `FunctionTypeSymbol`
/// cache is name-keyed.
open class Issue1532ObjectToTypeParamCastEmitTests {
    @Fact
    func EndToEnd_UnconstrainedT_BoxedValue_RoundTrips() {
        const source = `package i1532unconval
import System

func Uncon[T](o object) T { return T(o) }

func Main() {
    let a object = 42
    Console.WriteLine(Uncon[int32](a))
}`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_UnconstrainedT_Reference_RoundTrips() {
        const source = `package i1532unconref
import System

func Uncon[T](o object) T { return T(o) }

func Main() {
    let b object = "hi"
    Console.WriteLine(Uncon[string](b))
}`
        let output = CompileAndRun(source)
        Assert.Equal("hi${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_ClassConstrainedT_Reference_RoundTrips() {
        const source = `package i1532classref
import System

func RefC[T class](o object) T { return T(o) }

func Main() {
    let b object = "world"
    Console.WriteLine(RefC[string](b))
}`
        let output = CompileAndRun(source)
        Assert.Equal("world${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_StructConstrainedT_BoxedValue_RoundTrips() {
        const source = `package i1532structval
import System

func ValC[T struct](o object) T { return T(o) }

func Main() {
    let a object = 7
    Console.WriteLine(ValC[int32](a))
}`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_InterfaceConstrainedT_RoundTrips() {
        const source = `package i1532iface
import System

interface IShape { func Area() int32; }

struct Sq(S int32) : IShape { func Area() int32 { return S } }

func IfaceC[T IShape](o object) T { return T(o) }

func Main() {
    let a object = Sq(5)
    Console.WriteLine(IfaceC[Sq](a).Area())
}`
        let output = CompileAndRun(source)
        Assert.Equal("5${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NullableObjectSource_BoxedValue_RoundTrips() {
        // `object?` reaches the same explicit conversion via its `object`
        // ClrType; a non-null boxed value unboxes back to the value type.
        const source = `package i1532nullobj
import System

func Uncon[T](o object?) T { return T(o) }

func Main() {
    let a object? = 99
    Console.WriteLine(Uncon[int32](a))
}`
        let output = CompileAndRun(source)
        Assert.Equal("99${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_DelegateMarshalling_Invoke_RoundTrips() {
        // The real Oahu driver: a delegate-marshalling invoker casts each
        // erased `object` argument to the delegate's declared type parameter.
        const source = `package i1532delegate
import System

func Invoke[T1, T2](delgat (T1, T2) -> object, p []object) object {
    return delgat(T1(p[0]), T2(p[1]))
}

func Add(a int32, b string) object { return a }

func Main() {
    let ps = []object{50, "x"}
    Console.WriteLine(Invoke[int32, string](Add, ps))
}`
        let output = CompileAndRun(source)
        Assert.Equal("50${Environment.NewLine}", output)
    }

    @Fact
    func Negative_ImplicitObjectToTypeParam_IsRejected() {
        // The new conversion is EXPLICIT only: an implicit `object -> T` (no
        // cast) must still be rejected — C# reports CS0266 ("an explicit
        // conversion exists"), gsc reports the matching GS0156.
        const source = "package i1532negimplicit\nfunc Bad[T](o object) T { return o }"
        let (exit, stdout, stderr) = TryCompileLibrary(source)
        Assert.True(exit != 0, (`expected compile failure but succeeded.
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
        Assert.Contains("GS0156", stdout + stderr)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1532_exe_").FullName
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

        private func TryCompileLibrary(source string)(Exit int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_1532_neg_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
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
                return (compileExit, stdoutWriter.ToString(), stderrWriter.ToString())
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
