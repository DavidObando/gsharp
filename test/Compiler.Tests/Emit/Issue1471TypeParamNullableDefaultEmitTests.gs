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

/// Contextual defaults retain symbolic nullable arguments for known-kind parameters.
/// Original mixed-kind sources require GS0641 under ADR-0224.
/// Nullable value defaults are absent; reference defaults are null.
open class Issue1471TypeParamNullableDefaultEmitTests {
    @Fact
    func EndToEnd_FacetA_TaskFromResultDefaultValueTypeInstantiation_RunsAndPrintsAbsence() {
        let source = `package Probe1471a
import System
import System.Threading.Tasks

class Box1471A[T] {
    func Make() Task[T?] -> Task.FromResult[T?](default)
}

func Main() {
    Console.WriteLine(Box1471A[int32]().Make().Result)
}`
        Issue6040GenericNullableReturnDriverTests.CheckRejectedAnnotations(source, []string{"T"}, 2)
        let supported = source.Replace("Box1471A[T]", "Box1471A[T struct]").Replace(
            "Console.WriteLine(Box1471A[int32]().Make().Result)",
            "Console.WriteLine(Box1471A[int32]().Make().Result == nil)"
        )
        let output = CompileAndRun(supported)
        Assert.Equal("True${Environment.NewLine}", output)
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
        Issue6040GenericNullableReturnDriverTests.CheckRejectedAnnotations(source, []string{"T"}, 2)
        let output = CompileAndRun(source.Replace("Box1471B[T]", "Box1471B[T class?]"))
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
        Issue6040GenericNullableReturnDriverTests.CheckRejectedAnnotations(source, []string{"T", "U"}, 3)
        let output = CompileAndRun(
            source.Replace("Identity1471C[U]", "Identity1471C[U class?]").Replace("Box1471C[T]", "Box1471C[T class?]")
        )
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
