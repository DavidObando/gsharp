// <copyright file="Issue1567GetOnlyCollectionInitEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit
import Xunit.Sdk

/// End-to-end emit tests for issue #1567 — populating a get-only collection
/// property at construction via a braced collection-initializer nested inside
/// an object/composite initializer (`T{ Member: { a, b } }`). This mirrors
/// C#'s `new T { Prop = { a, b } }`, which lowers to
/// `receiver.Prop.Add(a); receiver.Prop.Add(b);` and therefore does NOT
/// require a setter on `Prop`.
///
/// Each test compiles a G# program, IL-verifies the produced assembly, runs it,
/// and asserts the runtime contents (counts, elements, dictionary lookups) so
/// the lowering to `Add` / indexer-set against the get-only property's
/// backing collection is exercised at execution time. Every user type is given
/// a unique name because the name-keyed FunctionTypeSymbol cache is not cleared
/// between tests.
open class Issue1567GetOnlyCollectionInitEmitTests {
    @Fact
    func GetOnlyList_EmptySingleAndMany_Add() {
        // Empty, single, and many-element braced initializers all lower to
        // Add calls on the get-only IList property's backing list.
        let source = `package Issue1567List
import System
import System.Collections.Generic

class BagL1567 {
    prop Items IList[int32] { get; init; }
    init() {
        Items = List[int32]()
    }
}

var empty = BagL1567{ Items: {} }
Console.WriteLine(empty.Items.Count)

var one = BagL1567{ Items: { 42 } }
Console.WriteLine(one.Items.Count)
Console.WriteLine(one.Items[0])

var many = BagL1567{ Items: { 10, 20, 30 } }
Console.WriteLine(many.Items.Count)
Console.WriteLine(many.Items[0])
Console.WriteLine(many.Items[2])`
        Assert.Equal(
            "0${Environment.NewLine}1${Environment.NewLine}42${Environment.NewLine}3${Environment.NewLine}10${Environment.NewLine}30${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func GetOnlyCollection_StringElements_Add() {
        // A get-only System.Collections.ObjectModel.Collection[string] populated
        // via the braced form, alongside a settable scalar member on the same
        // composite literal.
        let source = `package Issue1567Coll
import System
import System.Collections.Generic
import System.Collections.ObjectModel

class BagC1567 {
    prop Tag string { get; init; }
    prop Names Collection[string] { get; init; }
    init() {
        Tag = ""
        Names = Collection[string]()
    }
}

var b = BagC1567{ Tag: "hi", Names: { "alice", "bob", "carol" } }
Console.WriteLine(b.Tag)
Console.WriteLine(b.Names.Count)
Console.WriteLine(b.Names[0])
Console.WriteLine(b.Names[2])`
        Assert.Equal(
            "hi${Environment.NewLine}3${Environment.NewLine}alice${Environment.NewLine}carol${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func GetOnlyDictionary_KeyedAndIndexedEntries_Add() {
        // A get-only IDictionary populated with both the "k": v and ["k"] = v
        // entry spellings; both lower to Add(k, v) / indexer-set.
        let source = `package Issue1567Dict
import System
import System.Collections.Generic

class BagD1567 {
    prop Lookup IDictionary[string, int32] { get; init; }
    init() {
        Lookup = Dictionary[string, int32]()
    }
}

var b = BagD1567{ Lookup: { "a": 1, ["b"] = 2, "c": 3 } }
Console.WriteLine(b.Lookup.Count)
Console.WriteLine(b.Lookup["a"])
Console.WriteLine(b.Lookup["b"])
Console.WriteLine(b.Lookup["c"])`
        Assert.Equal(
            "3${Environment.NewLine}1${Environment.NewLine}2${Environment.NewLine}3${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func SettableCollectionProperty_BracedForm_AlsoAdds() {
        // C# uses Add-lowering for `Prop = { ... }` even when the property is
        // settable. The braced form must therefore Add (not replace) regardless
        // of writability — proven by pre-seeding the collection in init().
        let source = `package Issue1567Settable
import System
import System.Collections.Generic

class BagS1567 {
    prop Items IList[int32] { get; set; }
    init() {
        Items = List[int32]()
        Items.Add(1)
    }
}

var b = BagS1567{ Items: { 2, 3 } }
Console.WriteLine(b.Items.Count)
Console.WriteLine(b.Items[0])
Console.WriteLine(b.Items[2])`
        Assert.Equal("3${Environment.NewLine}1${Environment.NewLine}3${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func GetOnlyNonCollection_ScalarAssign_ReportsGs0127() {
        // GS0127 must still fire for a genuine attempt to assign a
        // non-collection get-only property via the plain (non-braced) form.
        let source = `package Issue1567Neg1
import System

class BagN1567 {
    prop RoInt int32 { get; }
    init() {
    }
}

var b = BagN1567{ RoInt: 5 }`
        let (exit, diagnostics) = CompileExpectingFailure(source)
        Assert.NotEqual(0, exit)
        Assert.Contains("GS0127", diagnostics)
    }

    @Fact
    func BracedFormOnNonCollectionProperty_ReportsGs0369() {
        // The braced form on a member whose type has no accessible Add must
        // report GS0369 (not collection-initializable), never an internal
        // error and never a silent assignment.
        let source = `package Issue1567Neg2
import System

class BagM1567 {
    prop RoInt int32 { get; init; }
    init() {
        RoInt = 0
    }
}

var b = BagM1567{ RoInt: { 1, 2 } }`
        let (exit, diagnostics) = CompileExpectingFailure(source)
        Assert.NotEqual(0, exit)
        Assert.Contains("GS0369", diagnostics)
    }

    shared {
        private func CompileAndRun(source string) string {
            let (exit, output, diagnostics) = Compile(source, run: true)
            Assert.True(exit == 0, "compile/run failed ($exit): $diagnostics")
            return output
        }

        private func CompileExpectingFailure(source string)(Exit int32, Diagnostics string) {
            let (exit, _, diagnostics) = Compile(source, run: false)
            return (exit, diagnostics)
        }

        private func Compile(source string, run bool)(Exit int32, Output string, Diagnostics string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1567_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(
                        []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                    )
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                let diagnostics = compileOut.ToString() + compileErr.ToString()
                if compileExit != 0 || !run {
                    return (compileExit, string.Empty, diagnostics)
                }
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
                return (0, stdout.ReplaceLineEndings(Environment.NewLine), diagnostics)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
