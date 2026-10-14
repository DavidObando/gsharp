// <copyright file="Issue1339PropertyDictionaryReceiverEmitTests.cs" company="GSharp">
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

/// Issue #1339: a bare instance-property name used as the receiver of a member
/// access (`Prop.Member`) must emit the property getter call before the
/// member access. Before the fix the receiver fell through to the bare-variable
/// path in the member-access binder and emitted as a load of a non-existent
/// local slot named after the property (`GS9998: Variable 'Entries' has no
/// local slot…`). The regression surfaced through a property-typed
/// `Dictionary[K, V]` whose `.Values`/`.Keys` were iterated, but
/// the underlying gap affected ANY instance-property member-access receiver.
/// These tests compile, IL-verify, and execute a program exercising the
/// property-receiver forms, asserting field/property parity at runtime.
open class Issue1339PropertyDictionaryReceiverEmitTests {
    @Fact
    func PropertyDictionary_ValuesIteration_EmitsAndRuns() {
        let source = `package P
import System
import System.Collections.Generic

data class E(Value uint32) {}

open class C {
    prop Entries Dictionary[uint32, E] { get; set }

    func Seed() {
        Entries = Dictionary[uint32, E]()
        let k1 uint32 = 1
        let k2 uint32 = 2
        Entries.Add(k1, E(10))
        Entries.Add(k2, E(20))
    }

    func SumValues() uint32 {
        var total uint32 = 0
        for e in Entries.Values {
            total = total + e.Value
        }
        return total
    }
}

let c = C{ }
c.Seed()
Console.WriteLine(c.SumValues())`
        Assert.Equal("30${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func PropertyDictionary_KeysRead_EmitsAndRuns() {
        let source = `package P
import System
import System.Collections.Generic

data class E(Value uint32) {}

open class C {
    prop Entries Dictionary[uint32, E] { get; set }

    func Seed() {
        Entries = Dictionary[uint32, E]()
        let k1 uint32 = 7
        Entries.Add(k1, E(1))
    }

    func KeyCount() int32 {
        let ks = Entries.Keys
        return ks.Count
    }
}

let c = C{ }
c.Seed()
Console.WriteLine(c.KeyCount())`
        Assert.Equal("1${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func PropertyList_CountMember_EmitsAndRuns() {
        // The underlying gap is general: any instance-property used as a
        // member-access receiver (here `Items.Count` and `Items.Add(...)`)
        // must emit the getter call rather than a bare local load.
        let source = `package P
import System
import System.Collections.Generic

open class C {
    prop Items List[int32] { get; set }

    func Seed() {
        Items = List[int32]()
        Items.Add(1)
        Items.Add(2)
        Items.Add(3)
    }

    func HowMany() int32 { return Items.Count }
}

let c = C{ }
c.Seed()
Console.WriteLine(c.HowMany())`
        Assert.Equal("3${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func FieldDictionary_ValuesIteration_StillRuns() {
        // Field control (#1328/#1334): the field-receiver path must keep
        // working identically to the property case above.
        let source = `package P
import System
import System.Collections.Generic

data class E(Value uint32) {}

class C {
    var Entries Dictionary[uint32, E] = Dictionary[uint32, E]()

    func Seed() {
        let k1 uint32 = 1
        let k2 uint32 = 2
        Entries.Add(k1, E(10))
        Entries.Add(k2, E(20))
    }

    func SumValues() uint32 {
        var total uint32 = 0
        for e in Entries.Values {
            total = total + e.Value
        }
        return total
    }
}

let c = C{ }
c.Seed()
Console.WriteLine(c.SumValues())`
        Assert.Equal("30${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1339_emit_").FullName
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
