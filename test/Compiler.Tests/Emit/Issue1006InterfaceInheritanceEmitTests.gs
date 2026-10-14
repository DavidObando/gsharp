// <copyright file="Issue1006InterfaceInheritanceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1006: end-to-end emit + execute coverage for interface inheritance
/// (`interface B : A`). An interface that extends another interface
/// inherits its members, records the base interface in metadata as an
/// InterfaceImpl row on its TypeDef, and a class implementing the derived
/// interface must satisfy both the inherited and the declared members. Calling
/// an inherited member through a base-typed reference dispatches to the
/// implementer.
///
/// Each test compiles via `gsc`, ilverifies the produced PE, then runs the
/// assembly under `dotnet exec` and asserts on captured stdout.
open class Issue1006InterfaceInheritanceEmitTests {
    @Fact
    func DerivedInterface_DispatchesInheritedAndDeclaredMembers() {
        // `b.F()` is inherited from A; `b.G()` is declared on B. Both are
        // dispatched through a B-typed reference to the C implementation.
        let source = `package t
import System

interface A { func F() int32; }
interface B : A { func G() int32; }

class C : B {
    func F() int32 { return 10 }
    func G() int32 { return 32 }
}

var b B = C{}
Console.WriteLine(b.F())
Console.WriteLine(b.G())
Console.WriteLine(b.F() + b.G())`
        let output = CompileAndRun(source)
        Assert.Equal("10${Environment.NewLine}32${Environment.NewLine}42${Environment.NewLine}", output)
    }

    @Fact
    func DerivedInterface_RecordsBaseInterfaceImplInMetadata() {
        // The derived interface declares the base interface, so the runtime
        // sees A as assignable-from B (an InterfaceImpl row was emitted).
        let source = `package t
import System

interface A { func F() int32; }
interface B : A { func G() int32; }

class C : B {
    func F() int32 { return 7 }
    func G() int32 { return 0 }
}

var c = C{}
var a A = c
Console.WriteLine(a.F())`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func InterfaceWithMultipleBases_DispatchesAllMembers() {
        let source = `package t
import System

interface A { func F() int32; }
interface C2 { func H() int32; }
interface B : A, C2 { func G() int32; }

class Impl : B {
    func F() int32 { return 1 }
    func G() int32 { return 2 }
    func H() int32 { return 3 }
}

var b B = Impl{}
Console.WriteLine(b.F() + b.G() + b.H())`
        let output = CompileAndRun(source)
        Assert.Equal("6${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1006_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath)
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
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
