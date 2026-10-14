// <copyright file="Issue1151NullableBranchUnifyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1151: end-to-end CLR emit coverage for unifying a value-type arm and
/// a `nil` arm of an `if`/`switch`-expression to `T?`. The
/// emitted nullable must round-trip: the present branch yields a
/// `Nullable<T>` with a value, and the `nil` branch yields the
/// missing-value `Nullable<T>` (lowered to a `default(T?)` temp
/// slot), and ilverify must accept the assembly.
open class Issue1151NullableBranchUnifyEmitTests {
    @Fact
    func EndToEnd_IfExpression_ValueTypeAndNil_RoundTrips() {
        let source = `package Probe
import System

class Box {
    func F(present bool) int32? {
        let x = if present { 5 } else { nil }
        return x
    }
}

func Main() {
    var b = Box()
    Console.WriteLine(Describe(b.F(true)))
    Console.WriteLine(Describe(b.F(false)))
}

func Describe(v int32?) int32 {
    return v ?? -1
}`
        let output = CompileAndRun(source)
        Assert.Equal("5${Environment.NewLine}-1${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_IfExpression_TargetTyped_ValueTypeAndNil_RoundTrips() {
        let source = `package Probe
import System

class Box {
    func G(present bool) int32? {
        let x int32? = if present { 5 } else { nil }
        return x
    }
}

func Main() {
    var b = Box()
    Console.WriteLine(Describe(b.G(true)))
    Console.WriteLine(Describe(b.G(false)))
}

func Describe(v int32?) int32 {
    return v ?? -1
}`
        let output = CompileAndRun(source)
        Assert.Equal("5${Environment.NewLine}-1${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_SwitchExpression_ValueTypeAndNil_RoundTrips() {
        let source = `package Probe
import System

class Box {
    func S(present bool) int32? {
        let x = switch present { case true: 42 default: nil }
        return x
    }
}

func Main() {
    var b = Box()
    Console.WriteLine(Describe(b.S(true)))
    Console.WriteLine(Describe(b.S(false)))
}

func Describe(v int32?) int32 {
    return v ?? -1
}`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}-1${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_Mpeg4StyleUInt32AndNil_RoundTrips() {
        let source = `package Probe
import System

class Reader {
    func Field(present bool) uint32? {
        let v = if present { 123u } else { nil }
        return v
    }
}

func Main() {
    var r = Reader()
    Console.WriteLine(Describe(r.Field(true)))
    Console.WriteLine(Describe(r.Field(false)))
}

func Describe(v uint32?) uint32 {
    return v ?? 999u
}`
        let output = CompileAndRun(source)
        Assert.Equal("123${Environment.NewLine}999${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_nil1151_exe_").FullName
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
