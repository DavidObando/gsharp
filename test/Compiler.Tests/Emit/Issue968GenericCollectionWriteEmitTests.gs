// <copyright file="Issue968GenericCollectionWriteEmitTests.cs" company="GSharp">
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

/// Issue #968: a generic WRITE into a CLR generic collection inside a member
/// body — e.g. `_items[i] = value` where `_items` is a `List[T]`
/// and `T` is the enclosing type's generic type parameter — failed to
/// compile with `GS0155` ("Cannot convert type 'T' to 'object'").
/// Discovered/deferred during PR #963 (issue #944, user indexer declarations),
/// whose generic get/set test dodged this by backing storage with a single
/// `T` field instead of writing into a `List[T]`.
///
/// Root cause: the WRITE binding path for a CLR indexer on an
/// `ImportedTypeSymbol` typed the assigned value from
/// `idxProp.PropertyType`, which on an open generic container is the
/// type-erased CLR `object` (`T -> object`). Binding the write
/// `_items[i] = value` then attempted a `T -> object` conversion
/// and was rejected. The READ path already recovered the symbolic element type
/// via `MapErasedIndexerElementType` (issues #313 / #671 / #957); the
/// WRITE path is the counterpart and now substitutes the open `set_Item`
/// value parameter back through the receiver's symbolic type arguments, yielding
/// the real element type (`T`) so the value binds without a spurious box.
///
/// These tests compile, IL-verify, and actually run programs that write a
/// `List[T]` element via indexer assignment inside a generic member body,
/// covering a value-type `T` (primitive and `data struct`), a
/// reference-type `T`, a user indexer `set` delegating to a
/// `List[T]` (the exact deferred #944 shape), the `List[T].Add` path,
/// and a `Dictionary[K, T]` write — plus a read-back regression guard that
/// mirrors #957.
open class Issue968GenericCollectionWriteEmitTests {
    @Fact
    func GenericListIndexerWrite_ValueTypePrimitive_Compiles_And_Runs() {
        // The headline repro: `_items[i] = value` where `value: T` and T is the
        // enclosing type's generic parameter, closed over a value-type (int32).
        let source = `package P
import System
import System.Collections.Generic

class Store[T] {
    private let _items List[T] = List[T]()
    func Add(item T) { _items.Add(item) }
    func SetAt(index int32, value T) { _items[index] = value }
    func GetAt(index int32) T { return _items[index] }
}

let s = Store[int32]()
s.Add(0)
s.SetAt(0, 42)
Console.WriteLine(s.GetAt(0))`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func GenericListIndexerWrite_ValueTypeDataStruct_Compiles_And_Runs() {
        // Value-type T as a same-compilation `data struct`: boxing differs from
        // a primitive, so the write must store the raw struct value (no box).
        let source = `package P
import System
import System.Collections.Generic

data struct Item(Name string, Price int32)

class Store[T] {
    private let _items List[T] = List[T]()
    func Add(item T) { _items.Add(item) }
    func SetAt(index int32, value T) { _items[index] = value }
    func GetAt(index int32) T { return _items[index] }
}

let s = Store[Item]()
s.Add(Item{Name: "x", Price: 1})
s.SetAt(0, Item{Name: "y", Price: 42})
Console.WriteLine(s.GetAt(0).Name)
Console.WriteLine(s.GetAt(0).Price)`
        Assert.Equal("y${Environment.NewLine}42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func GenericListIndexerWrite_ReferenceType_Compiles_And_Runs() {
        // Reference-type T (string): the write is a `stelem.ref`-style store of
        // an already-reference value, so no box is involved — the regression
        // guard for the value-type fix.
        let source = `package P
import System
import System.Collections.Generic

class Store[T] {
    private let _items List[T] = List[T]()
    func Add(item T) { _items.Add(item) }
    func SetAt(index int32, value T) { _items[index] = value }
    func GetAt(index int32) T { return _items[index] }
}

let s = Store[string]()
s.Add("a")
s.SetAt(0, "hello")
Console.WriteLine(s.GetAt(0))`
        Assert.Equal("hello${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func GenericUserIndexerSet_DelegatesToListOfT_Compiles_And_Runs() {
        // The exact shape deferred in PR #963 (issue #944): a user indexer whose
        // `set` accessor writes `value` (typed T) into a backing `List[T]`,
        // instead of a single `T` field. Previously rejected with GS0155.
        let source = `package P
import System
import System.Collections.Generic

class Repo[T] {
    private let _items List[T] = List[T]()
    func Add(item T) { _items.Add(item) }
    prop this[index int32] T {
        get { return _items[index] }
        set { _items[index] = value }
    }
}

let r = Repo[int32]()
r.Add(0)
r[0] = 99
Console.WriteLine(r[0])`
        Assert.Equal("99${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func GenericListAdd_ValueTypeT_Compiles_And_Runs() {
        // The sibling `List[T].Add(value)` write path with a value-type T,
        // exercised standalone with multiple appends and a read-back.
        let source = `package P
import System
import System.Collections.Generic

class Bag[T] {
    private let _items List[T] = List[T]()
    func Push(item T) { _items.Add(item) }
    func At(index int32) T { return _items[index] }
    func Count() int32 { return _items.Count }
}

let b = Bag[int32]()
b.Push(10)
b.Push(20)
b.Push(30)
Console.WriteLine(b.Count())
Console.WriteLine(b.At(0) + b.At(1) + b.At(2))`
        Assert.Equal("3${Environment.NewLine}60${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func GenericDictionaryWrite_ValueTypeValueT_Compiles_And_Runs() {
        // Sibling container: `Dictionary[K, T]` indexer write with a value-type
        // T must round-trip through the symbolic value type.
        let source = `package P
import System
import System.Collections.Generic

class Lookup[T] {
    private let _m Dictionary[string, T] = Dictionary[string, T]()
    func Set(k string, v T) { _m[k] = v }
    func Get(k string) T { return _m[k] }
}

let m = Lookup[int32]()
m.Set("a", 7)
m.Set("b", 35)
Console.WriteLine(m.Get("a") + m.Get("b"))`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func GenericListIndexerWrite_OverwriteThenRead_Compiles_And_Runs() {
        // Write, overwrite, and read back the same slot to confirm the store
        // mutates the collection rather than a copy, with a value-type T.
        let source = `package P
import System
import System.Collections.Generic

class Store[T] {
    private let _items List[T] = List[T]()
    func Add(item T) { _items.Add(item) }
    func SetAt(index int32, value T) { _items[index] = value }
    func GetAt(index int32) T { return _items[index] }
}

let s = Store[int32]()
s.Add(1)
s.Add(2)
s.SetAt(0, 100)
s.SetAt(1, 200)
s.SetAt(0, 300)
Console.WriteLine(s.GetAt(0))
Console.WriteLine(s.GetAt(1))`
        Assert.Equal("300${Environment.NewLine}200${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue968_emit_").FullName
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
