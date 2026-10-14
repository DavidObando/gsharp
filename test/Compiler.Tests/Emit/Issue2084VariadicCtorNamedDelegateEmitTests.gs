// <copyright file="Issue2084VariadicCtorNamedDelegateEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2084 — follow-up to #2069/#2081: the fixed-portion argument loop of
/// a variadic constructor's arg-binding (`OverloadResolver.cs`, "Convert/
/// validate the fixed-portion arguments first") had the same
/// `!Conversion.Classify(argument.Type, parameter.Type).IsImplicit`
/// fastpath as the 4 sites patched in #2081, but was the 5th, unpatched call
/// site. A func/arrow literal passed as a NAMED-delegate-typed FIXED
/// parameter ahead of a variadic tail (e.g. `init(h TickHandler, args
/// ...int32)`) skipped the forced conversion wrap, so the emitter
/// materialised the lambda against its natural `Action<T>` shape
/// instead of the named delegate's own emitted TypeDef.
open class Issue2084VariadicCtorNamedDelegateEmitTests {
    @Fact
    func EndToEnd_NamedDelegateLambdaArg_InVariadicCtorFixedPortion_Runs() {
        const source = `package i2084variadicctor
import System

delegate TickHandler(n int32) void;

class C {
    var H TickHandler
    var Sum int32

    init(h TickHandler, args ...int32) {
        H = h
        var s int32 = 0
        for a in args {
            s = s + a
        }
        Sum = s
    }
}

func Main() {
    var c = C((n int32) -> System.Console.WriteLine(n * 3), 1, 2, 3)
    c.H(7)
    System.Console.WriteLine(c.Sum)
}`
        let output = CompileAndRun(source)
        Assert.Equal("21${Environment.NewLine}6${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2084_exe_").FullName
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
