// <copyright file="Issue957IndexerBoxingEmitTests.cs" company="GSharp">
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

/// Issue #957: an indexer read `xs[0]` on a `List[T]` whose element
/// type `T` is a <em>same-compilation</em> value type (a `data struct`)
/// segfaulted at runtime. Discovered during PR #956 (issue #939) and deferred.
///
/// Root cause: the indexer read path emits the `get_Item` call through the
/// receiver-aware MemberRef overload (issue #671), so the call is encoded
/// against the constructed symbolic type `List<Item>` and the runtime
/// stack value is the substituted element value type `Item` — NOT the
/// type-erased CLR `object` that the open `get_Item` return (`T`)
/// reports. The emitter nonetheless fed that erased `object` return into
/// `EmitErasedObjectReturnWidening`, which for a value-type element emits a
/// spurious `unbox.any Item` against a stack slot that already holds a raw
/// `Item` value — an ilverify `StackUnexpected` and a runtime SIGSEGV.
///
/// The fix mirrors the property-access (issue #774), instance-method (#832), and
/// imported-call (#903) variants: when the receiver normalizes to a symbolic
/// open-generic container closed over a substitutable user type, skip the
/// widening because the stack already holds the substituted element type.
///
/// These tests compile, IL-verify, and actually run programs that read a
/// `List[Item]` element via the indexer and assert the runtime output,
/// covering the `data struct` (value-type) case, member arithmetic,
/// nested generics, and reference-type / primitive regression guards.
open class Issue957IndexerBoxingEmitTests {
    @Fact
    func Indexer_ListOfDataStructItem_MemberRead_Compiles_And_Runs() {
        // The exact repro from issue #957: value-type element read via xs[0].
        let source = `package GapCheck
import System
import System.Collections.Generic

data struct Item(Name string, Price int32)

var xs = List[Item]()
xs.Add(Item{Name: "a", Price: 1})
var first = xs[0]
Console.WriteLine(first.Name)
Console.WriteLine(first.Price)`
        Assert.Equal("a${Environment.NewLine}1${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Indexer_ListOfDataStructItem_DirectMemberAccess_Compiles_And_Runs() {
        // Member access directly off the indexer expression (no intermediate
        // local) exercises the same get_Item read path.
        let source = `package GapCheck
import System
import System.Collections.Generic

data struct Item(Name string, Price int32)

var xs = List[Item]()
xs.Add(Item{Name: "x", Price: 7})
xs.Add(Item{Name: "y", Price: 9})
Console.WriteLine(xs[1].Name)
Console.WriteLine(xs[0].Price)`
        Assert.Equal("y${Environment.NewLine}7${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Indexer_ListOfDataStructItem_MemberArithmetic_Compiles_And_Runs() {
        // Uses the read element's member in arithmetic so the value type is
        // exercised on the stack, not just passed through WriteLine.
        let source = `package GapCheck
import System
import System.Collections.Generic

data struct Item(Name string, Price int32)

var xs = List[Item]()
xs.Add(Item{Name: "a", Price: 10})
xs.Add(Item{Name: "b", Price: 32})
var total = xs[0].Price + xs[1].Price
Console.WriteLine(total)`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Indexer_NestedListOfListOfDataStructItem_Compiles_And_Runs() {
        // Nested generic: the outer read recovers `List[Item]` (member-bearing)
        // and the inner read recovers the `Item` value type.
        let source = `package GapCheck
import System
import System.Collections.Generic

data struct Item(Name string, Price int32)

var outer = List[List[Item]]()
var inner = List[Item]()
inner.Add(Item{Name: "deep", Price: 7})
outer.Add(inner)
var got = outer[0][0]
Console.WriteLine(got.Name)
Console.WriteLine(got.Price)`
        Assert.Equal("deep${Environment.NewLine}7${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Indexer_ListOfClassItem_MemberRead_StillCompiles_And_Runs() {
        // Regression guard: a reference-type (class) element must keep working
        // after skipping the widening for the symbolic-container case.
        let source = `package GapCheck
import System
import System.Collections.Generic

class Item(Name string, Price int32)

var xs = List[Item]()
xs.Add(Item{Name: "a", Price: 1})
var first = xs[0]
Console.WriteLine(first.Name)
Console.WriteLine(first.Price)`
        Assert.Equal("a${Environment.NewLine}1${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Indexer_ListOfPrimitive_StillCompiles_And_Runs() {
        // Regression guard: primitive element reads must keep working.
        let source = `package GapCheck
import System
import System.Collections.Generic

var ns = List[int32]()
ns.Add(5)
ns.Add(6)
Console.WriteLine(ns[0])
Console.WriteLine(ns[1])`
        Assert.Equal("5${Environment.NewLine}6${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func Indexer_DictionaryWithDataStructValue_Read_Compiles_And_Runs() {
        // Sibling indexer: a Dictionary[string, Item] value-type read via d["k"]
        // must recover the user `Item` element.
        let source = `package GapCheck
import System
import System.Collections.Generic

data struct Item(Name string, Price int32)

var d = Dictionary[string, Item]()
d.Add("k", Item{Name: "dictval", Price: 3})
var v = d["k"]
Console.WriteLine(v.Name)
Console.WriteLine(v.Price)`
        Assert.Equal("dictval${Environment.NewLine}3${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue957_emit_").FullName
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
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
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
