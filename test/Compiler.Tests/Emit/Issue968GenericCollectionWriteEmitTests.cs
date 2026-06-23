// <copyright file="Issue968GenericCollectionWriteEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #968: a generic WRITE into a CLR generic collection inside a member
/// body — e.g. <c>_items[i] = value</c> where <c>_items</c> is a <c>List[T]</c>
/// and <c>T</c> is the enclosing type's generic type parameter — failed to
/// compile with <c>GS0155</c> ("Cannot convert type 'T' to 'object'").
/// Discovered/deferred during PR #963 (issue #944, user indexer declarations),
/// whose generic get/set test dodged this by backing storage with a single
/// <c>T</c> field instead of writing into a <c>List[T]</c>.
/// <para>
/// Root cause: the WRITE binding path for a CLR indexer on an
/// <c>ImportedTypeSymbol</c> typed the assigned value from
/// <c>idxProp.PropertyType</c>, which on an open generic container is the
/// type-erased CLR <c>object</c> (<c>T -&gt; object</c>). Binding the write
/// <c>_items[i] = value</c> then attempted a <c>T -&gt; object</c> conversion
/// and was rejected. The READ path already recovered the symbolic element type
/// via <c>MapErasedIndexerElementType</c> (issues #313 / #671 / #957); the
/// WRITE path is the counterpart and now substitutes the open <c>set_Item</c>
/// value parameter back through the receiver's symbolic type arguments, yielding
/// the real element type (<c>T</c>) so the value binds without a spurious box.
/// </para>
/// <para>
/// These tests compile, IL-verify, and actually run programs that write a
/// <c>List[T]</c> element via indexer assignment inside a generic member body,
/// covering a value-type <c>T</c> (primitive and <c>data struct</c>), a
/// reference-type <c>T</c>, a user indexer <c>set</c> delegating to a
/// <c>List[T]</c> (the exact deferred #944 shape), the <c>List[T].Add</c> path,
/// and a <c>Dictionary[K, T]</c> write — plus a read-back regression guard that
/// mirrors #957.
/// </para>
/// </summary>
public class Issue968GenericCollectionWriteEmitTests
{
    [Fact]
    public void GenericListIndexerWrite_ValueTypePrimitive_Compiles_And_Runs()
    {
        // The headline repro: `_items[i] = value` where `value: T` and T is the
        // enclosing type's generic parameter, closed over a value-type (int32).
        var source = """
            package P
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
            Console.WriteLine(s.GetAt(0))
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void GenericListIndexerWrite_ValueTypeDataStruct_Compiles_And_Runs()
    {
        // Value-type T as a same-compilation `data struct`: boxing differs from
        // a primitive, so the write must store the raw struct value (no box).
        var source = """
            package P
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
            Console.WriteLine(s.GetAt(0).Price)
            """;

        Assert.Equal("y\n42\n", CompileAndRun(source));
    }

    [Fact]
    public void GenericListIndexerWrite_ReferenceType_Compiles_And_Runs()
    {
        // Reference-type T (string): the write is a `stelem.ref`-style store of
        // an already-reference value, so no box is involved — the regression
        // guard for the value-type fix.
        var source = """
            package P
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
            Console.WriteLine(s.GetAt(0))
            """;

        Assert.Equal("hello\n", CompileAndRun(source));
    }

    [Fact]
    public void GenericUserIndexerSet_DelegatesToListOfT_Compiles_And_Runs()
    {
        // The exact shape deferred in PR #963 (issue #944): a user indexer whose
        // `set` accessor writes `value` (typed T) into a backing `List[T]`,
        // instead of a single `T` field. Previously rejected with GS0155.
        var source = """
            package P
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
            Console.WriteLine(r[0])
            """;

        Assert.Equal("99\n", CompileAndRun(source));
    }

    [Fact]
    public void GenericListAdd_ValueTypeT_Compiles_And_Runs()
    {
        // The sibling `List[T].Add(value)` write path with a value-type T,
        // exercised standalone with multiple appends and a read-back.
        var source = """
            package P
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
            Console.WriteLine(b.At(0) + b.At(1) + b.At(2))
            """;

        Assert.Equal("3\n60\n", CompileAndRun(source));
    }

    [Fact]
    public void GenericDictionaryWrite_ValueTypeValueT_Compiles_And_Runs()
    {
        // Sibling container: `Dictionary[K, T]` indexer write with a value-type
        // T must round-trip through the symbolic value type.
        var source = """
            package P
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
            Console.WriteLine(m.Get("a") + m.Get("b"))
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void GenericListIndexerWrite_OverwriteThenRead_Compiles_And_Runs()
    {
        // Write, overwrite, and read back the same slot to confirm the store
        // mutates the collection rather than a copy, with a value-type T.
        var source = """
            package P
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
            Console.WriteLine(s.GetAt(1))
            """;

        Assert.Equal("300\n200\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue968_emit_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(new[]
                {
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    srcPath,
                });
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");
            IlVerifier.Verify(outPath);

            var runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json");
            File.WriteAllText(runtimeConfigPath, """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var psi = new ProcessStartInfo("dotnet", "exec \"" + outPath + "\"")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var proc = Process.Start(psi)!;
            string stdout = proc.StandardOutput.ReadToEnd();
            string stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            if (proc.ExitCode != 0)
            {
                throw new Xunit.Sdk.XunitException("exited " + proc.ExitCode + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr);
            }

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
        }
    }
}
