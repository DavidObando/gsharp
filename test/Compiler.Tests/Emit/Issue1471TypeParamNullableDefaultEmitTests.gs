// <copyright file="Issue1471TypeParamNullableDefaultEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1471 — a bare `default` whose target type is `T?` for an
/// unconstrained open type parameter `T`, flowing as an argument to a
/// generic method instantiated with `T?` (e.g.
/// `Task.FromResult[T?](default)`), used to lower to a
/// `BoundDefaultExpression(object)` because the method type-argument erased
/// to the reference-context `object` placeholder. That emitted `ldnull`
/// against the bare type parameter `!T` the callee expects, which is
/// unverifiable (`StackUnexpected: found Nullobjref, expected value 'T'`)
/// and throws `InvalidProgramException` at runtime for a value-type
/// instantiation. The binder now recovers the symbolic parameter type from the
/// method's type-argument vector so the default emits the verifiable
/// `ldloca; initobj; ldloc` slot shape for both reference and value
/// instantiations.
/// - Facet A — the minimal repro instantiated with a VALUE type (`int32`): `default(int32)` = `0`.
/// - Facet B — instantiated with a REFERENCE type (`string`): `default(string)` = `null`.
/// - Facet C — a default argument to a user generic function other than `Task.FromResult`, proving the
/// fix is general.
open class Issue1471TypeParamNullableDefaultEmitTests {
    @Fact
    func EndToEnd_FacetA_TaskFromResultDefaultValueTypeInstantiation_RunsAndPrintsZero() {
        let source = `package Probe1471a
import System
import System.Threading.Tasks

class Box1471A[T] {
    func Make() Task[T?] -> Task.FromResult[T?](default)
}

func Main() {
    Console.WriteLine(Box1471A[int32]().Make().Result)
}`
        let output = CompileAndRun(source)
        Assert.Equal("0${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_FacetB_TaskFromResultDefaultReferenceTypeInstantiation_RunsAndPrintsNullSentinel() {
        let source = `package Probe1471b
import System
import System.Threading.Tasks

class Box1471B[T] {
    func Make() Task[T?] -> Task.FromResult[T?](default)
}

func Main() {
    let result = Box1471B[string]().Make().Result
    Console.WriteLine("[" + (result ?? "null") + "]")
}`
        let output = CompileAndRun(source)
        Assert.Equal("[null]${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_FacetC_DefaultArgumentToUserGenericFunction_Runs() {
        let source = `package Probe1471c
import System

func Identity1471C[U](u U?) U? -> u

class Box1471C[T] {
    func Make() T? -> Identity1471C[T](default)
}

func Main() {
    let result = Box1471C[string]().Make()
    Console.WriteLine("[" + (result ?? "null") + "]")
}`
        let output = CompileAndRun(source)
        Assert.Equal("[null]${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1471_exe_").FullName
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
