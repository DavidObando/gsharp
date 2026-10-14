// <copyright file="Issue1136ObjectMemberEmitTests.cs" company="GSharp">
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
import Xunit.Sdk

/// Issue #1136: inherited System.Object instance members must emit and run on
/// user class AND struct instances that declare no explicit imported base. A
/// reference-type (class) receiver dispatches via `callvirt`; a value-type
/// (struct) receiver whose inherited method is declared on a reference base
/// (System.Object) is boxed before the `callvirt`. These tests compile a
/// program that exercises GetType()/ToString()/GetHashCode()/Equals() on both
/// shapes, plus bare implicit-`this` GetType(), verify the IL, and assert
/// the runtime output. A user ToString() override must still take precedence.
open class Issue1136ObjectMemberEmitTests {
    @Fact
    func ObjectAlias_ReferenceEquals_ExactOahuShape_EmitsAndRuns() {
        let source = `package Oahu.Cli.Tui.Screens
import System

class Modal { }

let activeModal = Modal{}
let pendingModal = activeModal
Console.WriteLine(object.ReferenceEquals(activeModal, pendingModal))
Console.WriteLine(object.ReferenceEquals(activeModal, Modal{}))`
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ClassReceiver_ObjectMembers_EmitAndRun() {
        let source = `package P
import System

class C { }

let c = C{ }
Console.WriteLine(c.GetType().Name)
Console.WriteLine(c.Equals(c))
Console.WriteLine(c.GetHashCode() == c.GetHashCode())`
        Assert.Equal(
            "C${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func BareImplicitThis_GetType_EmitsAndRuns() {
        let source = `package P
import System

class C {
    func Name() string { return GetType().Name }
}

let c = C{ }
Console.WriteLine(c.Name())`
        Assert.Equal("C${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func StructReceiver_GetHashCodeAndGetType_BoxAndRun() {
        // The value-type receiver is boxed before callvirt for GetType() and
        // GetHashCode() (declared on System.Object). Two structurally-equal
        // structs hash equal and compare equal through the default value-type
        // semantics. Structs are built in locals (not top-level initonly
        // statics) so the receiver address is taken from a verifiable slot.
        let source = `package P
import System

struct S { var X int32 }

func Report() string {
    let a = S{ X: 5 }
    let b = S{ X: 5 }
    let name = a.GetType().Name
    let eq = a.Equals(b)
    let hashEq = a.GetHashCode() == b.GetHashCode()
    return name + " " + eq.ToString() + " " + hashEq.ToString()
}

Console.WriteLine(Report())`
        Assert.Equal("S True True${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func UserToStringOverride_TakesPrecedence_AtRuntime() {
        let source = `package P
import System

class C {
    func ToString() string { return "custom-C" }
}

let c = C{ }
Console.WriteLine(c.ToString())`
        Assert.Equal("custom-C${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EqualsAcrossUserClassInstances_EmitsAndRuns() {
        let source = `package P
import System

class C { }

let a = C{ }
let b = C{ }
Console.WriteLine(a.Equals(b))
Console.WriteLine(a.Equals(a))`
        Assert.Equal("False${Environment.NewLine}True${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func MethodGroup_InheritedToString_ConvertsToDelegateAndRuns() {
        // A bare `obj.ToString` (method-group position) on a user class with no
        // explicit imported base resolves the inherited System.Object.ToString
        // and converts to a delegate. The user override still takes precedence.
        let source = `package P
import System

class C { func ToString() string { return "custom-C" } }
class D { }

func Use(f () -> string) string { return f() }

let c = C{ }
let d = D{ }
let f () -> string = c.ToString
let g () -> string = d.ToString
Console.WriteLine(Use(f))
Console.WriteLine(Use(g))`
        Assert.Equal("custom-C${Environment.NewLine}P.D${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1136_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    srcPath
                }
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
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
                // (a) Static verification: the emitted IL must be valid.
                IlVerifier.Verify(outPath)
                // (b) Dynamic verification: the emitted code must execute.
                let runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json")
                File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                let psi = ProcessStartInfo("dotnet", "exec \"" + outPath + "\""){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
                using let proc = Process.Start(psi)!!
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                proc.WaitForExit()
                if proc.ExitCode != 0 {
                    throw XunitException("exited " + proc.ExitCode.ToString() + `
stdout:
` + stdout + `
stderr:
` + stderr)
                }
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
