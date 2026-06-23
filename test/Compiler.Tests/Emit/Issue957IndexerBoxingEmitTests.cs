// <copyright file="Issue957IndexerBoxingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #957: an indexer read <c>xs[0]</c> on a <c>List[T]</c> whose element
/// type <c>T</c> is a <em>same-compilation</em> value type (a <c>data struct</c>)
/// segfaulted at runtime. Discovered during PR #956 (issue #939) and deferred.
/// <para>
/// Root cause: the indexer read path emits the <c>get_Item</c> call through the
/// receiver-aware MemberRef overload (issue #671), so the call is encoded
/// against the constructed symbolic type <c>List&lt;Item&gt;</c> and the runtime
/// stack value is the substituted element value type <c>Item</c> — NOT the
/// type-erased CLR <c>object</c> that the open <c>get_Item</c> return (<c>T</c>)
/// reports. The emitter nonetheless fed that erased <c>object</c> return into
/// <c>EmitErasedObjectReturnWidening</c>, which for a value-type element emits a
/// spurious <c>unbox.any Item</c> against a stack slot that already holds a raw
/// <c>Item</c> value — an ilverify <c>StackUnexpected</c> and a runtime SIGSEGV.
/// </para>
/// <para>
/// The fix mirrors the property-access (issue #774), instance-method (#832), and
/// imported-call (#903) variants: when the receiver normalizes to a symbolic
/// open-generic container closed over a substitutable user type, skip the
/// widening because the stack already holds the substituted element type.
/// </para>
/// <para>
/// These tests compile, IL-verify, and actually run programs that read a
/// <c>List[Item]</c> element via the indexer and assert the runtime output,
/// covering the <c>data struct</c> (value-type) case, member arithmetic,
/// nested generics, and reference-type / primitive regression guards.
/// </para>
/// </summary>
public class Issue957IndexerBoxingEmitTests
{
    [Fact]
    public void Indexer_ListOfDataStructItem_MemberRead_Compiles_And_Runs()
    {
        // The exact repro from issue #957: value-type element read via xs[0].
        var source = """
            package GapCheck
            import System
            import System.Collections.Generic

            data struct Item(Name string, Price int32)

            var xs = List[Item]()
            xs.Add(Item{Name: "a", Price: 1})
            var first = xs[0]
            Console.WriteLine(first.Name)
            Console.WriteLine(first.Price)
            """;

        Assert.Equal("a\n1\n", CompileAndRun(source));
    }

    [Fact]
    public void Indexer_ListOfDataStructItem_DirectMemberAccess_Compiles_And_Runs()
    {
        // Member access directly off the indexer expression (no intermediate
        // local) exercises the same get_Item read path.
        var source = """
            package GapCheck
            import System
            import System.Collections.Generic

            data struct Item(Name string, Price int32)

            var xs = List[Item]()
            xs.Add(Item{Name: "x", Price: 7})
            xs.Add(Item{Name: "y", Price: 9})
            Console.WriteLine(xs[1].Name)
            Console.WriteLine(xs[0].Price)
            """;

        Assert.Equal("y\n7\n", CompileAndRun(source));
    }

    [Fact]
    public void Indexer_ListOfDataStructItem_MemberArithmetic_Compiles_And_Runs()
    {
        // Uses the read element's member in arithmetic so the value type is
        // exercised on the stack, not just passed through WriteLine.
        var source = """
            package GapCheck
            import System
            import System.Collections.Generic

            data struct Item(Name string, Price int32)

            var xs = List[Item]()
            xs.Add(Item{Name: "a", Price: 10})
            xs.Add(Item{Name: "b", Price: 32})
            var total = xs[0].Price + xs[1].Price
            Console.WriteLine(total)
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void Indexer_NestedListOfListOfDataStructItem_Compiles_And_Runs()
    {
        // Nested generic: the outer read recovers `List[Item]` (member-bearing)
        // and the inner read recovers the `Item` value type.
        var source = """
            package GapCheck
            import System
            import System.Collections.Generic

            data struct Item(Name string, Price int32)

            var outer = List[List[Item]]()
            var inner = List[Item]()
            inner.Add(Item{Name: "deep", Price: 7})
            outer.Add(inner)
            var got = outer[0][0]
            Console.WriteLine(got.Name)
            Console.WriteLine(got.Price)
            """;

        Assert.Equal("deep\n7\n", CompileAndRun(source));
    }

    [Fact]
    public void Indexer_ListOfClassItem_MemberRead_StillCompiles_And_Runs()
    {
        // Regression guard: a reference-type (class) element must keep working
        // after skipping the widening for the symbolic-container case.
        var source = """
            package GapCheck
            import System
            import System.Collections.Generic

            class Item(Name string, Price int32)

            var xs = List[Item]()
            xs.Add(Item{Name: "a", Price: 1})
            var first = xs[0]
            Console.WriteLine(first.Name)
            Console.WriteLine(first.Price)
            """;

        Assert.Equal("a\n1\n", CompileAndRun(source));
    }

    [Fact]
    public void Indexer_ListOfPrimitive_StillCompiles_And_Runs()
    {
        // Regression guard: primitive element reads must keep working.
        var source = """
            package GapCheck
            import System
            import System.Collections.Generic

            var ns = List[int32]()
            ns.Add(5)
            ns.Add(6)
            Console.WriteLine(ns[0])
            Console.WriteLine(ns[1])
            """;

        Assert.Equal("5\n6\n", CompileAndRun(source));
    }

    [Fact]
    public void Indexer_DictionaryWithDataStructValue_Read_Compiles_And_Runs()
    {
        // Sibling indexer: a Dictionary[string, Item] value-type read via d["k"]
        // must recover the user `Item` element.
        var source = """
            package GapCheck
            import System
            import System.Collections.Generic

            data struct Item(Name string, Price int32)

            var d = Dictionary[string, Item]()
            d.Add("k", Item{Name: "dictval", Price: 3})
            var v = d["k"]
            Console.WriteLine(v.Name)
            Console.WriteLine(v.Price)
            """;

        Assert.Equal("dictval\n3\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue957_emit_").FullName;
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
