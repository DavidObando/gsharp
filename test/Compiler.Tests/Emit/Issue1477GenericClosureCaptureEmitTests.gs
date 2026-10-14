// <copyright file="Issue1477GenericClosureCaptureEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1477 — a lambda declared inside a generic type (or generic method)
/// that captures a value whose type references an enclosing generic
/// type/method parameter (a `T`-typed parameter/local, `this` of
/// `G[T]`, or a boxed `Box[T]`) used to emit a NON-generic
/// synthesized display / capture-box class. Its capture field was then typed
/// `!0` with no generic parameter in scope — an illegal field type that
/// faulted at load (`System.TypeLoadException`) and produced unverifiable
/// IL (`StackUnexpected` at the capture store + `DelegateCtor` at the
/// delegate construction). The fix reifies the synthesized class generic over
/// exactly the referenced enclosing parameters (Roslyn semantics) and parents
/// the capture-site `newobj` / field stores / `ldftn Invoke` at the
/// constructed display-class TypeSpec.
/// - Facet A — a generic static factory whose lambda captures a `T`-typed parameter, value-type
/// instantiation (`Op[int]`).
/// - Facet B — the same shape with a reference-type instantiation (`Op[string]`).
/// - Facet C — a lambda capturing `this` / an instance field of `G[T]` (mirrors
/// `Mp4Operation`1.SetContinuation`).
/// - Facet D — a generic METHOD (MVAR) whose lambda captures the method's type-parameter-typed local.
/// All four faulted on current main and pass (clean ilverify + correct runtime
/// output) after the fix.
open class Issue1477GenericClosureCaptureEmitTests {
    @Fact
    func EndToEnd_FacetA_GenericFactoryCapturesTypeParamValue_ValueType_Runs() {
        let source = `package Cap1477A
import System
import System.Threading.Tasks

open class OpA[T] {
    private let cf (Task) -> T
    init(cf (Task) -> T) { this.cf = cf }
    func Run(t Task) T -> cf(t)
    shared {
        func FromCompleted(result T) OpA[T] -> OpA[T]((_ Task) -> result)
    }
}

func Main() {
    let o = OpA[int].FromCompleted(5)
    Console.WriteLine(o.Run(Task.CompletedTask))
}`
        let output = CompileAndRun(source)
        Assert.Equal("5${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_FacetB_GenericFactoryCapturesTypeParamValue_ReferenceType_Runs() {
        let source = `package Cap1477B
import System
import System.Threading.Tasks

open class OpB[T] {
    private let cf (Task) -> T
    init(cf (Task) -> T) { this.cf = cf }
    func Run(t Task) T -> cf(t)
    shared {
        func FromCompleted(result T) OpB[T] -> OpB[T]((_ Task) -> result)
    }
}

func Main() {
    let o = OpB[string].FromCompleted("hello")
    Console.WriteLine(o.Run(Task.CompletedTask))
}`
        let output = CompileAndRun(source)
        Assert.Equal("hello${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_FacetC_LambdaCapturesThisOfGenericType_Runs() {
        let source = `package Cap1477C
import System

open class HolderC[T] {
    let value T
    init(value T) { this.value = value }
    func MakeGetter() () -> T -> () -> this.value
}

func Main() {
    let h = HolderC[int](42)
    let g = h.MakeGetter()
    Console.WriteLine(g())
}`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_FacetD_GenericMethodLambdaCapturesMethodTypeParamLocal_Runs() {
        let source = `package Cap1477D
import System

class UtilD {
    shared {
        func MakeGetter[U](item U) () -> U {
            let local = item
            return () -> local
        }
    }
}

func Main() {
    let g = UtilD.MakeGetter[int](99)
    Console.WriteLine(g())
    let gs = UtilD.MakeGetter[string]("world")
    Console.WriteLine(gs())
}`
        let output = CompileAndRun(source)
        Assert.Equal("99${Environment.NewLine}world${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1477_exe_").FullName
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
