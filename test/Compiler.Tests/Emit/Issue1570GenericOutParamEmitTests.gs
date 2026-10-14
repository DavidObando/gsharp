// <copyright file="Issue1570GenericOutParamEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1570 — calling a generic method that declares a `ref`/`out`
/// parameter whose type is a method (or containing) type parameter crashed emit
/// with `GS9998: InvalidOperationException: Cannot encode '*T' as a non-byref
/// signature slot`. The MethodSpec type-argument inference unified the open
/// type parameter against the argument's managed-pointer type (`T&`)
/// and returned the byref itself as the inferred type argument; the MethodSpec
/// blob encoder then rejected the byref because a generic type argument can
/// never be a managed pointer.
///
/// The fix peels the `T&` wrapper off both the formal and actual sides
/// during unification, so the inferred type argument is the pointee type. Each
/// test uses a UNIQUE package/type name because the in-process
/// `FunctionTypeSymbol` cache is name-keyed and leaks across tests.
open class Issue1570GenericOutParamEmitTests {
    @Fact
    func EndToEnd_GenericOutParam_OpenTypeParam_Runs() {
        const source = `package i1570outopen
import System

class Holder {
    shared {
        func TryMake[T](val T, out result T) bool {
            result = val
            return true
        }
    }
}

func Make[T](v T) T {
    Holder.TryMake[T](v, out var result)
    return result
}

func Main() {
    System.Console.WriteLine(Make[int32](42))
}`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_GenericOutParam_ConcreteTypeArg_Runs() {
        const source = `package i1570concrete
import System

class Keeper {
    shared {
        func TryMake[T](val T, out result T) bool {
            result = val
            return true
        }
    }
}

func Main() {
    Keeper.TryMake[int32](7, out var result)
    System.Console.WriteLine(result)
}`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_GenericRefParam_OpenTypeParam_Runs() {
        const source = `package i1570refopen
import System

class Mover {
    shared {
        func Swap[T](src T, ref dst T) {
            dst = src
        }
    }
}

func Apply[T](v T, seed T) T {
    var r T = seed
    Mover.Swap[T](v, ref r)
    return r
}

func Main() {
    System.Console.WriteLine(Apply[int32](99, 0))
}`
        let output = CompileAndRun(source)
        Assert.Equal("99${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NonGenericOutParam_ControlStillWorks() {
        const source = `package i1570control
import System

func TryGet(s string, out result int32) bool {
    result = 5
    return true
}

func Main() {
    TryGet("x", out var r)
    System.Console.WriteLine(r)
}`
        let output = CompileAndRun(source)
        Assert.Equal("5${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1570_exe_").FullName
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
