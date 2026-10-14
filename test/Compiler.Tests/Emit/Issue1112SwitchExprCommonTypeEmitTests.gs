// <copyright file="Issue1112SwitchExprCommonTypeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1112: end-to-end CLR emit coverage for switch-expression
/// best-common-type / target-typing. A switch-expression whose arms produce
/// different derived types (sharing a common base class or interface) must
/// unify to that base/interface, both when the result is inferred into a
/// local and when it is returned directly from a typed function. The emitted
/// switch must produce a value statically typed as the common type so the
/// stack slot / local is uniform, and ilverify must accept the assembly.
open class Issue1112SwitchExprCommonTypeEmitTests {
    @Fact
    func EndToEnd_CommonBaseClass_LetInference_RunsAndDispatchesVirtually() {
        let source = `package Probe
import System

open class Base {
    open func Name() string { return "base" }
}
class A : Base {
    override func Name() string { return "a" }
}
class B : Base {
    override func Name() string { return "b" }
}

class Factory {
    func PickLet(s string) Base {
        let box = switch s {
            case "a": A()
            case "b": B()
            default: A()
        }
        return box
    }
}

func Main() {
    var f = Factory()
    Console.WriteLine(f.PickLet("a").Name())
    Console.WriteLine(f.PickLet("b").Name())
    Console.WriteLine(f.PickLet("z").Name())
}`
        let output = CompileAndRun(source)
        Assert.Equal("a${Environment.NewLine}b${Environment.NewLine}a${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_CommonBaseClass_DirectReturn_RunsAndDispatchesVirtually() {
        let source = `package Probe
import System

open class Base {
    open func Name() string { return "base" }
}
class A : Base {
    override func Name() string { return "a" }
}
class B : Base {
    override func Name() string { return "b" }
}

class Factory {
    func PickReturn(s string) Base {
        return switch s {
            case "a": A()
            case "b": B()
            default: A()
        }
    }
}

func Main() {
    var f = Factory()
    Console.WriteLine(f.PickReturn("a").Name())
    Console.WriteLine(f.PickReturn("b").Name())
    Console.WriteLine(f.PickReturn("z").Name())
}`
        let output = CompileAndRun(source)
        Assert.Equal("a${Environment.NewLine}b${Environment.NewLine}a${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_CommonInterface_RunsAndDispatchesVirtually() {
        let source = `package Probe
import System

interface IShape {
    func Area() float64;
}
class Sq : IShape {
    func Area() float64 { return 4.0 }
}
class Ci : IShape {
    func Area() float64 { return 3.0 }
}

class Factory {
    func Pick(s string) IShape {
        let box = switch s {
            case "sq": Sq()
            default: Ci()
        }
        return box
    }
}

func Main() {
    var f = Factory()
    Console.WriteLine(f.Pick("sq").Area())
    Console.WriteLine(f.Pick("ci").Area())
}`
        let output = CompileAndRun(source)
        Assert.Equal("4${Environment.NewLine}3${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_sw1112_exe_").FullName
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
