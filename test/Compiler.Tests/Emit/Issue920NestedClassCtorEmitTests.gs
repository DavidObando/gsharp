// <copyright file="Issue920NestedClassCtorEmitTests.cs" company="GSharp">
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

/// Issue #920 / ADR-0110: a nested (user-declared, nested-inside-another-type)
/// class that declares an `init()` constructor — or whose ctor body is
/// emitted later in the emission pass than a construction site — must have its
/// ctor handle pre-registered so `newobj` sites resolve it. Before the fix
/// the emitter threw "Type '…' has no emitted primary ctor." because the
/// enclosing class's method bodies are emitted strictly before the unified
/// nested-type pass that records nested ctors.
///
/// IMPORTANT: every same-compilation user type gets a UNIQUE name per test
/// method, because `FunctionTypeSymbol.Cache` aliases by type-name string
/// and would otherwise surface stale symbols across tests.
open class Issue920NestedClassCtorEmitTests {
    @Fact
    func NestedClassWithInitCtor_ConstructedFromEnclosingMethod_Runs() {
        let output = CompileAndRun(`package P

import System

class Outer920A {
    class Inner920A {
        prop X int32
        init() {
            X = 5
        }
        func Get() int32 {
            return X
        }
    }

    func Make() int32 {
        let i = Inner920A()
        return i.Get()
    }
}

let o = Outer920A()
Console.WriteLine(o.Make())`)
        Assert.Equal("5${Environment.NewLine}", output)
    }

    @Fact
    func NestedClassWithInitCtor_ObjectInitializerConstruction_Runs() {
        // The exact issue #920 reproduction: a nested class implementing an
        // interface, with an init() that sets defaults, constructed with an
        // object-initializer that overrides one property.
        let output = CompileAndRun(`package P

import System

interface IBroker920B {
    func Answer() string;
}

class Outer920B {
    class CBRecordingBroker920B : IBroker920B {
        prop MfaAnswer string
        prop CvfAnswer string
        prop MfaCalls int32

        init() {
            MfaAnswer = "000000"
            CvfAnswer = "0000"
            MfaCalls = 0
        }

        func Answer() string {
            return MfaAnswer
        }
    }

    func Make() string {
        var bb = CBRecordingBroker920B() { MfaAnswer = "987654" }
        return bb.Answer()
    }
}

let o = Outer920B()
Console.WriteLine(o.Make())`)
        Assert.Equal("987654${Environment.NewLine}", output)
    }

    @Fact
    func NestedClassWithInitCtor_DispatchedThroughInterface_Runs() {
        // Construct the nested class, upcast it to the nested-implemented
        // interface, and dispatch through the interface.
        let output = CompileAndRun(`package P

import System

interface IBroker920C {
    func Answer() string;
}

class Outer920C {
    class Broker920C : IBroker920C {
        prop Value string
        init() {
            Value = "from-init"
        }
        func Answer() string {
            return Value
        }
    }

    func Make() string {
        var i IBroker920C = Broker920C()
        return i.Answer()
    }
}

let o = Outer920C()
Console.WriteLine(o.Make())`)
        Assert.Equal("from-init${Environment.NewLine}", output)
    }

    @Fact
    func TopLevelClass_ConstructsLaterDeclaredInitCtorClass_Runs() {
        // The same root cause also affected two TOP-LEVEL classes when the
        // constructing class is declared before the constructed (explicit-ctor)
        // class. Pre-registration fixes both shapes.
        let output = CompileAndRun(`package P

import System

class Builder920D {
    func Make() int32 {
        let w = Widget920D()
        return w.Get()
    }
}

class Widget920D {
    prop X int32
    init() {
        X = 9
    }
    func Get() int32 {
        return X
    }
}

let b = Builder920D()
Console.WriteLine(b.Make())`)
        Assert.Equal("9${Environment.NewLine}", output)
    }

    @Fact
    func NestedClassWithInitCtor_ConstructedFromTopLevelCode_Runs() {
        // A nested class constructed directly from top-level program code (not
        // only from an enclosing method) must also resolve its ctor.
        let output = CompileAndRun(`package P

import System

class Outer920E {
    class Inner920E {
        prop N int32
        init() {
            N = 42
        }
        func Get() int32 {
            return N
        }
    }
}

let i = Inner920E()
Console.WriteLine(i.Get())`)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue920_emit_").FullName
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
                Assert.True(compileExit == 0, (`compile failed (` + "$compileExit" + `):
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath)
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
