// <copyright file="Issue939ForInUserElementTypeEmitTests.cs" company="GSharp">
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

/// Issue #939: iterating a `List[T]` (or any CLR generic enumerable)
/// whose element type `T` is a <em>same-compilation</em> user type
/// (a `class` or a `data struct`) used to erase the loop
/// variable's type in the `for … in …` binder. Member access on the
/// loop variable then failed with `GS0158` / `GS0159` even though
/// the equivalent indexer access bound fine.
///
/// Root cause: the for-in binder (and the matching enumerator lowering)
/// only mapped the open CLR element type back through the receiver's
/// symbolic type arguments when `HasTypeParameterArgument` was true
/// (i.e. the argument was an in-scope generic parameter such as `T`).
/// For a concrete same-compilation user type the argument is not a type
/// parameter, so the receiver fell through to the type-erased
/// `List<object>` path and the loop variable collapsed to
/// `object`. The fix broadens the predicate to
/// `HasSubstitutableTypeArgument`, mirroring the indexer path, so the
/// loop variable recovers the member-bearing user symbol.
///
/// These tests compile, IL-verify, and actually run programs that iterate
/// a `List[Item]` with `for it in xs { … it.Name … }` and assert
/// the runtime output, covering both the `data struct` and the
/// `class` element-type cases.
open class Issue939ForInUserElementTypeEmitTests {
    @Fact
    func ForIn_ListOfDataStructItem_MemberAccess_Compiles_And_Runs() {
        // The exact repro from issue #939: data struct element type.
        let source = `package GapCheck
import System
import System.Collections.Generic

data struct Item(Name string, Price int32)

var xs = List[Item]()
xs.Add(Item{Name: "a", Price: 1})
xs.Add(Item{Name: "b", Price: 2})
for it in xs {
    Console.WriteLine(it.Name)
    Console.WriteLine(it.Price)
}`
        Assert.Equal(
            "a${Environment.NewLine}1${Environment.NewLine}b${Environment.NewLine}2${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func ForIn_ListOfClassItem_MemberAccess_Compiles_And_Runs() {
        // The issue notes `class Item(...)` fails identically — verify the
        // reference-type element type works end to end too.
        let source = `package GapCheck
import System
import System.Collections.Generic

class Item(Name string, Price int32)

var xs = List[Item]()
xs.Add(Item{Name: "a", Price: 1})
xs.Add(Item{Name: "b", Price: 2})
for it in xs {
    Console.WriteLine(it.Name)
    Console.WriteLine(it.Price)
}`
        Assert.Equal(
            "a${Environment.NewLine}1${Environment.NewLine}b${Environment.NewLine}2${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func ForIn_ListOfDataStructItem_SumsMembers_Compiles_And_Runs() {
        // Reads a member into an accumulator so the loop variable's type is
        // exercised in arithmetic, not just a passthrough WriteLine.
        let source = `package GapCheck
import System
import System.Collections.Generic

data struct Item(Name string, Price int32)

var xs = List[Item]()
xs.Add(Item{Name: "a", Price: 10})
xs.Add(Item{Name: "b", Price: 32})
var total = 0
for it in xs {
    total = total + it.Price
}
Console.WriteLine(total)`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ForIn_NestedListOfListOfDataStructItem_Compiles_And_Runs() {
        // Nested generic: `List[List[Item]]`. The outer loop variable must
        // recover `List[Item]` (member-bearing) and the inner loop variable
        // must recover `Item`.
        let source = `package GapCheck
import System
import System.Collections.Generic

data struct Item(Name string, Price int32)

var outer = List[List[Item]]()
var inner = List[Item]()
inner.Add(Item{Name: "deep", Price: 7})
outer.Add(inner)
for lst in outer {
    for it in lst {
        Console.WriteLine(it.Name)
        Console.WriteLine(it.Price)
    }
}`
        Assert.Equal("deep${Environment.NewLine}7${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ForIn_DictionaryWithDataStructValue_TwoVar_Compiles_And_Runs() {
        // Sibling enumerable that shares the for-in open-receiver path: a
        // `Dictionary[string, Item]` two-variable range must recover the
        // user `Item` for the value variable (pre-fix this also erased to
        // `object`).
        let source = `package GapCheck
import System
import System.Collections.Generic

data struct Item(Name string, Price int32)

var d = Dictionary[string, Item]()
d.Add("k", Item{Name: "dictval", Price: 3})
for key, v in d {
    Console.WriteLine(key)
    Console.WriteLine(v.Name)
    Console.WriteLine(v.Price)
}`
        Assert.Equal(
            "k${Environment.NewLine}dictval${Environment.NewLine}3${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func ForIn_DictionaryWithClassValue_TwoVar_Compiles_And_Runs() {
        // Same as above but with a reference-type (class) value.
        let source = `package GapCheck
import System
import System.Collections.Generic

class Item(Name string, Price int32)

var d = Dictionary[string, Item]()
d.Add("k", Item{Name: "dictval", Price: 3})
for key, v in d {
    Console.WriteLine(key)
    Console.WriteLine(v.Name)
    Console.WriteLine(v.Price)
}`
        Assert.Equal(
            "k${Environment.NewLine}dictval${Environment.NewLine}3${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func ForIn_ListOfPrimitive_StillCompiles_And_Runs() {
        // Regression guard: the primitive element control must keep working
        // after broadening the open-receiver predicate.
        let source = `package GapCheck
import System
import System.Collections.Generic

var ns = List[int32]()
ns.Add(5)
ns.Add(6)
for n in ns {
    Console.WriteLine(n)
}`
        Assert.Equal("5${Environment.NewLine}6${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ForIn_ListOfNativeTuple_StillCompiles_And_Runs() {
        // Regression guard: the native-tuple element control must keep
        // working after broadening the open-receiver predicate.
        let source = `package GapCheck
import System
import System.Collections.Generic

var ts = List[(string, int32)]()
ts.Add(("x", 9))
for t in ts {
    Console.WriteLine(t.Item1)
    Console.WriteLine(t.Item2)
}`
        Assert.Equal("x${Environment.NewLine}9${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue939_emit_").FullName
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
