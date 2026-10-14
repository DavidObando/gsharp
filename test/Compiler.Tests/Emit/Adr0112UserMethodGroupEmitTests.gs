// <copyright file="Adr0112UserMethodGroupEmitTests.cs" company="GSharp">
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

/// ADR-0112 (unified member resolution): a user-defined type's `shared`
/// (static) or instance method may be converted to a delegate via a method
/// group — `Use(Box.Make)`, `Use(c.Get)`, and the bare implicit-this
/// forms. Emit must produce verifiable IL: a static group binds a null
/// delegate target (`ldnull; ldftn`), an instance group binds the receiver
/// (boxing value-type receivers), and an rvalue receiver is spilled to a local
/// by the slot planner so its address can be taken.
open class Adr0112UserMethodGroupEmitTests {
    @Fact
    func StaticMethodGroup_ViaTypeName_EmitsAndRuns() {
        let source = `package P
import System

class Box {
    var tag int32
    shared {
        func Make() Box { return Box{ tag: 7 } }
    }
}

func Use(f () -> Box) int32 { return f().tag }

Console.WriteLine(Use(Box.Make))`
        Assert.Equal("7${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func InstanceMethodGroup_ViaReceiver_EmitsAndRuns() {
        let source = `package P
import System

class Counter {
    var n int32
    func Get() int32 { return n }
}

func Use(f () -> int32) int32 { return f() }

var c = Counter{ n: 42 }
Console.WriteLine(Use(c.Get))`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func BareSharedMethodGroup_InsideMethod_EmitsAndRuns() {
        let source = `package P
import System

class Factory {
    shared {
        func Make() int32 { return 5 }
    }

    func Build() int32 {
        var f () -> int32 = Make
        return f()
    }
}

var fac = Factory{}
Console.WriteLine(fac.Build())`
        Assert.Equal("5${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func BareInstanceMethodGroup_InsideMethod_CapturesThisAndRuns() {
        let source = `package P
import System

class Widget {
    var value int32
    func Read() int32 { return value }

    func AsDelegate() int32 {
        var f () -> int32 = Read
        return f()
    }
}

var w = Widget{ value: 9 }
Console.WriteLine(w.AsDelegate())`
        Assert.Equal("9${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func InstanceMethodGroup_RvalueReceiver_SpillsAndRuns() {
        // The receiver is the rvalue result of a call, so the slot planner must
        // spill it into a local before the method-group emit can reference it.
        let source = `package P
import System

class Counter {
    var n int32
    func Get() int32 { return n }
}

func Make() Counter { return Counter{ n: 21 } }
func Use(f () -> int32) int32 { return f() }

Console.WriteLine(Use(Make().Get))`
        Assert.Equal("21${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func InheritedInstanceMethodGroup_ViaReceiver_EmitsAndRuns() {
        // ADR-0112 A6: the method group resolves an instance method inherited
        // from a base class through TypeMemberModel.GetMethods' this-first base
        // walk (formerly StructSymbol.GetMethodsIncludingInherited). Unique type
        // names avoid FunctionTypeSymbol.Cache aliasing across in-process runs.
        let source = `package P
import System

open class A6InhGroupBase {
    var seed int32
    func Seed() int32 { return seed }
}

class A6InhGroupDerived : A6InhGroupBase {
}

func A6UseSeed(f () -> int32) int32 { return f() }

var d = A6InhGroupDerived{ seed: 33 }
Console.WriteLine(A6UseSeed(d.Seed))`
        Assert.Equal("33${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func InheritedBareInstanceMethodGroup_InsideDerivedMethod_EmitsAndRuns() {
        // ADR-0112 A6: the bare implicit-`this` method group inside a derived
        // class method resolves a base-class instance method via the inherited
        // base walk in TypeMemberModel.GetMethods.
        let source = `package P
import System

open class A6BareInhBase {
    var amount int32
    func Amount() int32 { return amount }
}

class A6BareInhDerived : A6BareInhBase {
    func AsDelegate() int32 {
        var f () -> int32 = Amount
        return f()
    }
}

var x = A6BareInhDerived{ amount: 17 }
Console.WriteLine(x.AsDelegate())`
        Assert.Equal("17${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ExtensionMethodGroup_ClosesStaticReceiverOnce_AndPreservesMethodIdentity() {
        let source = `package P
import System

var receiverReads = 0

func NextText() string {
    receiverReads++
    return "abc"
}

func (text string) Checksum32() uint32 -> uint32(text.Length)

let checksum () -> uint32 = NextText().Checksum32
Console.WriteLine(receiverReads)
Console.WriteLine(checksum())
Console.WriteLine(checksum.Method.Name)
Console.WriteLine("group=${NextText().Checksum32}")
Console.WriteLine(receiverReads)`
        let output = CompileAndRun(source)
        Assert.StartsWith(
            "1${Environment.NewLine}3${Environment.NewLine}Checksum32${Environment.NewLine}group=System.Func`1[System.UInt32]${Environment.NewLine}2${Environment.NewLine}",
            output,
            StringComparison.Ordinal
        )
    }

    @Fact
    func ImportedExtensionMethodGroup_ClosesReceiver_AndRuns() {
        let source = `package P
import System
import System.Collections.Generic
import System.Linq

let values = List[int32]()
values.Add(1)
values.Add(2)
let items IEnumerable[int32] = values
let count () -> int32 = items.Count

Console.WriteLine(count())
Console.WriteLine(count.Method.Name)`
        Assert.Equal("2${Environment.NewLine}Count${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_adr0112_emit_").FullName
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
