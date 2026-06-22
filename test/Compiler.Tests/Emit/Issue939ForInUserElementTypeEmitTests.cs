// <copyright file="Issue939ForInUserElementTypeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #939: iterating a <c>List[T]</c> (or any CLR generic enumerable)
/// whose element type <c>T</c> is a <em>same-compilation</em> user type
/// (a <c>class</c> or a <c>data struct</c>) used to erase the loop
/// variable's type in the <c>for … in …</c> binder. Member access on the
/// loop variable then failed with <c>GS0158</c> / <c>GS0159</c> even though
/// the equivalent indexer access bound fine.
/// <para>
/// Root cause: the for-in binder (and the matching enumerator lowering)
/// only mapped the open CLR element type back through the receiver's
/// symbolic type arguments when <c>HasTypeParameterArgument</c> was true
/// (i.e. the argument was an in-scope generic parameter such as <c>T</c>).
/// For a concrete same-compilation user type the argument is not a type
/// parameter, so the receiver fell through to the type-erased
/// <c>List&lt;object&gt;</c> path and the loop variable collapsed to
/// <c>object</c>. The fix broadens the predicate to
/// <c>HasSubstitutableTypeArgument</c>, mirroring the indexer path, so the
/// loop variable recovers the member-bearing user symbol.
/// </para>
/// <para>
/// These tests compile, IL-verify, and actually run programs that iterate
/// a <c>List[Item]</c> with <c>for it in xs { … it.Name … }</c> and assert
/// the runtime output, covering both the <c>data struct</c> and the
/// <c>class</c> element-type cases.
/// </para>
/// </summary>
public class Issue939ForInUserElementTypeEmitTests
{
    [Fact]
    public void ForIn_ListOfDataStructItem_MemberAccess_Compiles_And_Runs()
    {
        // The exact repro from issue #939: data struct element type.
        var source = """
            package GapCheck
            import System
            import System.Collections.Generic

            data struct Item(Name string, Price int32)

            var xs = List[Item]()
            xs.Add(Item{Name: "a", Price: 1})
            xs.Add(Item{Name: "b", Price: 2})
            for it in xs {
                Console.WriteLine(it.Name)
                Console.WriteLine(it.Price)
            }
            """;

        Assert.Equal("a\n1\nb\n2\n", CompileAndRun(source));
    }

    [Fact]
    public void ForIn_ListOfClassItem_MemberAccess_Compiles_And_Runs()
    {
        // The issue notes `class Item(...)` fails identically — verify the
        // reference-type element type works end to end too.
        var source = """
            package GapCheck
            import System
            import System.Collections.Generic

            class Item(Name string, Price int32)

            var xs = List[Item]()
            xs.Add(Item{Name: "a", Price: 1})
            xs.Add(Item{Name: "b", Price: 2})
            for it in xs {
                Console.WriteLine(it.Name)
                Console.WriteLine(it.Price)
            }
            """;

        Assert.Equal("a\n1\nb\n2\n", CompileAndRun(source));
    }

    [Fact]
    public void ForIn_ListOfDataStructItem_SumsMembers_Compiles_And_Runs()
    {
        // Reads a member into an accumulator so the loop variable's type is
        // exercised in arithmetic, not just a passthrough WriteLine.
        var source = """
            package GapCheck
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
            Console.WriteLine(total)
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void ForIn_NestedListOfListOfDataStructItem_Compiles_And_Runs()
    {
        // Nested generic: `List[List[Item]]`. The outer loop variable must
        // recover `List[Item]` (member-bearing) and the inner loop variable
        // must recover `Item`.
        var source = """
            package GapCheck
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
            }
            """;

        Assert.Equal("deep\n7\n", CompileAndRun(source));
    }

    [Fact]
    public void ForIn_DictionaryWithDataStructValue_TwoVar_Compiles_And_Runs()
    {
        // Sibling enumerable that shares the for-in open-receiver path: a
        // `Dictionary[string, Item]` two-variable range must recover the
        // user `Item` for the value variable (pre-fix this also erased to
        // `object`).
        var source = """
            package GapCheck
            import System
            import System.Collections.Generic

            data struct Item(Name string, Price int32)

            var d = Dictionary[string, Item]()
            d.Add("k", Item{Name: "dictval", Price: 3})
            for key, v in d {
                Console.WriteLine(key)
                Console.WriteLine(v.Name)
                Console.WriteLine(v.Price)
            }
            """;

        Assert.Equal("k\ndictval\n3\n", CompileAndRun(source));
    }

    [Fact]
    public void ForIn_DictionaryWithClassValue_TwoVar_Compiles_And_Runs()
    {
        // Same as above but with a reference-type (class) value.
        var source = """
            package GapCheck
            import System
            import System.Collections.Generic

            class Item(Name string, Price int32)

            var d = Dictionary[string, Item]()
            d.Add("k", Item{Name: "dictval", Price: 3})
            for key, v in d {
                Console.WriteLine(key)
                Console.WriteLine(v.Name)
                Console.WriteLine(v.Price)
            }
            """;

        Assert.Equal("k\ndictval\n3\n", CompileAndRun(source));
    }

    [Fact]
    public void ForIn_ListOfPrimitive_StillCompiles_And_Runs()
    {
        // Regression guard: the primitive element control must keep working
        // after broadening the open-receiver predicate.
        var source = """
            package GapCheck
            import System
            import System.Collections.Generic

            var ns = List[int32]()
            ns.Add(5)
            ns.Add(6)
            for n in ns {
                Console.WriteLine(n)
            }
            """;

        Assert.Equal("5\n6\n", CompileAndRun(source));
    }

    [Fact]
    public void ForIn_ListOfNativeTuple_StillCompiles_And_Runs()
    {
        // Regression guard: the native-tuple element control must keep
        // working after broadening the open-receiver predicate.
        var source = """
            package GapCheck
            import System
            import System.Collections.Generic

            var ts = List[(string, int32)]()
            ts.Add(("x", 9))
            for t in ts {
                Console.WriteLine(t.Item1)
                Console.WriteLine(t.Item2)
            }
            """;

        Assert.Equal("x\n9\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue939_emit_").FullName;
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
