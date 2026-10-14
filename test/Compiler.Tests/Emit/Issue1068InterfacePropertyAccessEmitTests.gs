// <copyright file="Issue1068InterfacePropertyAccessEmitTests.cs" company="GSharp">
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

/// Issue #1068: end-to-end emit + execute coverage for reading and writing a
/// property through an interface-typed reference. Interface methods already
/// dispatched correctly; property access on an interface receiver previously
/// failed to bind (GS0158). The fix routes interface property reads/writes
/// through the canonical member-resolution layer and emits a verifiable
/// `callvirt get_X` / `callvirt set_X` against the abstract interface
/// accessor.
///
/// Each test compiles via `gsc`, ilverifies the produced PE, then runs the
/// assembly under `dotnet exec` and asserts on captured stdout.
open class Issue1068InterfacePropertyAccessEmitTests {
    @Fact
    func GetOnlyProperty_ReadThroughInterfaceReference_DispatchesToImplementer() {
        let source = `package t
import System

interface IBase { prop H int32 { get; } }

class C : IBase {
    prop H int32 { get; init; }
    init(h int32) { H = h }
}

func read(b IBase) int32 { return b.H }

var c = C(42)
Console.WriteLine(read(c))`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func InheritedAndDeclaredProperties_ReadAndWriteThroughInterfaceReference() {
        // H is inherited from IBase; W is declared on IDerived with a setter.
        // All access goes through interface-typed references.
        let source = `package t
import System

interface IBase { prop H int32 { get; } }
interface IDerived : IBase { prop W int32 { get; set; } }

class C : IDerived {
    prop H int32 { get; init; }
    prop W int32 { get; set; }
    init(h int32) { H = h }
}

func readH(b IBase) int32 { return b.H }
func writeW(d IDerived, v int32) { d.W = v }

var c = C(40)
writeW(c, 2)
var d IDerived = c
Console.WriteLine(readH(c))
Console.WriteLine(d.W)
Console.WriteLine(d.H)
Console.WriteLine(readH(c) + d.W + d.H)`
        let output = CompileAndRun(source)
        Assert.Equal(
            "40${Environment.NewLine}2${Environment.NewLine}40${Environment.NewLine}82${Environment.NewLine}",
            output
        )
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1068_").FullName
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
