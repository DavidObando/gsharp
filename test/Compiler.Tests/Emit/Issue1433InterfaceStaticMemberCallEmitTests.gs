// <copyright file="Issue1433InterfaceStaticMemberCallEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1433 — calling a static (`shared`) member declared on a
/// user-defined `interface`. Before the fix the binder produced no
/// resolution for `IName.Method(args)` (and interface static property
/// reads / method groups), leaking a (cref:GSharp.Core.CodeAnalysis.Binding.BoundErrorExpression)
/// into emit which crashed with a misleading `GS0423` ("for-in loop")
/// internal compiler error. These tests cover the generalized fix: interface
/// static method calls (used + discarded), a static method group, a static
/// property read, and a constructed generic interface static method call,
/// validated end-to-end (compile + run). Every user type is uniquely named so
/// the process-wide `FunctionTypeSymbol` cache cannot alias across tests.
open class Issue1433InterfaceStaticMemberCallEmitTests {
    @Fact
    func EndToEnd_InterfaceStaticMethodCall_UsedAndDiscarded_Runs() {
        let source = `package Probe1433a
import System

interface IThingA1433 {
    prop Name string { get; }
    shared {
        func Create(n int32) IThingA1433 {
            return ThingA1433(n)
        }
    }
}

class ThingA1433(N int32) : IThingA1433 {
    prop Name string -> "t${N}"
}

func Main() {
    let t = IThingA1433.Create(7)
    Console.WriteLine(t.Name)
    IThingA1433.Create(99)
    Console.WriteLine("done")
}`
        let output = CompileAndRun(source)
        Assert.Equal("t7${Environment.NewLine}done${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_InterfaceStaticMethodOverloads_AndArgumentPosition_Runs() {
        let source = `package Probe1433b
import System

interface IFactoryB1433 {
    shared {
        func Make() string {
            return "none"
        }
        func Make(n int32) string {
            return "int${n}"
        }
        func Make(s string) string {
            return "str${s}"
        }
    }
}

func Use(value string) string -> value

func Main() {
    Console.WriteLine(IFactoryB1433.Make())
    Console.WriteLine(IFactoryB1433.Make(5))
    Console.WriteLine(Use(IFactoryB1433.Make("x")))
}`
        let output = CompileAndRun(source)
        Assert.Equal("none${Environment.NewLine}int5${Environment.NewLine}strx${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_InterfaceStaticProperty_Read_Runs() {
        let source = `package Probe1433c
import System

sealed interface IDataC1433 {
    shared {
        prop Origin string { get { return "origin" } }
    }
}

func Main() {
    Console.WriteLine(IDataC1433.Origin)
}`
        let output = CompileAndRun(source)
        Assert.Equal("origin${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_ConstructedGenericInterfaceStaticMethodCall_Runs() {
        let source = `package Probe1433e
import System

interface IBoxE1433[T] {
    shared {
        func Tag() int32 {
            return 7
        }
    }
}

func Main() {
    Console.WriteLine(IBoxE1433[int32].Tag())
    Console.WriteLine(IBoxE1433[string].Tag())
}`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}7${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_InterfaceStaticMethodCall_InReturnPosition_Runs() {
        let source = `package Probe1433f
import System

interface IThingF1433 {
    prop Name string { get; }
    shared {
        func Create(n int32) IThingF1433 {
            return ThingF1433(n)
        }
    }
}

class ThingF1433(N int32) : IThingF1433 {
    prop Name string -> "f${N}"
}

func Build() IThingF1433 -> IThingF1433.Create(3)

func Main() {
    Console.WriteLine(Build().Name)
}`
        let output = CompileAndRun(source)
        Assert.Equal("f3${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1433_exe_").FullName
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
