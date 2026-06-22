// <copyright file="Issue479CollectionInitializerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// End-to-end emit tests for issue #479 — C#/Swift-style collection
/// initializers. Each test compiles a G# program that uses a collection
/// initializer (list/set/dictionary/indexed/ctor-args), IL-verifies the
/// produced assembly, runs it, and asserts the runtime contents
/// (counts, membership, lookups) so the lowering to ctor + <c>Add</c> /
/// indexer-set is exercised at execution time.
/// <para>
/// The forms under test are specified by ADR-0117. The lowering produces
/// a synthetic local seeded by the constructor call followed by a chain
/// of <c>Add</c> / indexer-set statements; because that reuses existing
/// bound nodes, the emitter and interpreter execute it unchanged. These
/// tests lock the surface in at the emit layer.
/// </para>
/// </summary>
public class Issue479CollectionInitializerEmitTests
{
    [Fact]
    public void ListInitializer_AddsAllElementsInOrder()
    {
        // Bare-element list initializer lowers to ctor + Add per element.
        var source = """
            package App
            import System
            import System.Collections.Generic

            let xs = List[int32]{ 1, 2, 3 }
            Console.WriteLine(xs.Count)
            Console.WriteLine(xs[0])
            Console.WriteLine(xs[2])
            """;

        Assert.Equal("3\n1\n3\n", CompileAndRun(source));
    }

    [Fact]
    public void SetInitializer_DeduplicatesElements()
    {
        // HashSet.Add ignores duplicates, so the runtime Count reflects
        // the deduplicated membership — proof the Add path actually runs.
        var source = """
            package App
            import System
            import System.Collections.Generic

            let hs = HashSet[int32]{ 1, 2, 2, 3, 3, 3 }
            Console.WriteLine(hs.Count)
            Console.WriteLine(hs.Contains(2))
            Console.WriteLine(hs.Contains(9))
            """;

        Assert.Equal("3\nTrue\nFalse\n", CompileAndRun(source));
    }

    [Fact]
    public void SetInitializer_EmptyParensForm_IsEquivalent()
    {
        // The explicit empty-parens spelling HashSet[int32](){...} must be
        // equivalent to the no-parens form.
        var source = """
            package App
            import System
            import System.Collections.Generic

            let hs = HashSet[int32](){ 10, 20, 30 }
            Console.WriteLine(hs.Count)
            Console.WriteLine(hs.Contains(20))
            """;

        Assert.Equal("3\nTrue\n", CompileAndRun(source));
    }

    [Fact]
    public void DictionaryInitializer_KeyedPairs_AddEntries()
    {
        // key: value pairs lower to Add(k, v). Lookups confirm the right
        // values landed against the right keys.
        var source = """
            package App
            import System
            import System.Collections.Generic

            let d = Dictionary[string, int32]{ "a": 1, "b": 2, "c": 3 }
            Console.WriteLine(d.Count)
            Console.WriteLine(d["a"])
            Console.WriteLine(d["c"])
            """;

        Assert.Equal("3\n1\n3\n", CompileAndRun(source));
    }

    [Fact]
    public void DictionaryInitializer_IndexedEntries_SetViaIndexer()
    {
        // [key] = value lowers to the indexer-set path (overwrite
        // semantics), distinct from the keyed-pair Add path.
        var source = """
            package App
            import System
            import System.Collections.Generic

            let d = Dictionary[string, int32]{ ["x"] = 7, ["y"] = 8 }
            Console.WriteLine(d.Count)
            Console.WriteLine(d["x"])
            Console.WriteLine(d["y"])
            """;

        Assert.Equal("2\n7\n8\n", CompileAndRun(source));
    }

    [Fact]
    public void DictionaryInitializer_IndexedEntries_LastDuplicateWins()
    {
        // Indexer-set overwrite semantics: a repeated key must not throw
        // (unlike Add) and the last assignment must win.
        var source = """
            package App
            import System
            import System.Collections.Generic

            let d = Dictionary[string, int32]{ ["k"] = 1, ["k"] = 99 }
            Console.WriteLine(d.Count)
            Console.WriteLine(d["k"])
            """;

        Assert.Equal("1\n99\n", CompileAndRun(source));
    }

    [Fact]
    public void DictionaryInitializer_WithConstructorArgs_UsesComparer()
    {
        // The explicit-ctor-args form matching the C# new(StringComparer
        // .OrdinalIgnoreCase){...} case. The case-insensitive comparer is
        // observable: a differently-cased lookup must hit the entry.
        var source = """
            package App
            import System
            import System.Collections.Generic

            let d = Dictionary[string, int32](StringComparer.OrdinalIgnoreCase){ "Key": 5 }
            Console.WriteLine(d.Count)
            Console.WriteLine(d["key"])
            Console.WriteLine(d["KEY"])
            """;

        Assert.Equal("1\n5\n5\n", CompileAndRun(source));
    }

    [Fact]
    public void ListInitializer_WithTrailingComma_IsLegal()
    {
        var source = """
            package App
            import System
            import System.Collections.Generic

            let xs = List[int32]{ 1, 2, 3, }
            Console.WriteLine(xs.Count)
            """;

        Assert.Equal("3\n", CompileAndRun(source));
    }

    [Fact]
    public void NestedCollectionInitializers_Compose()
    {
        // A collection initializer element may itself be a collection
        // initializer. Confirms recursion through the bind/lower path.
        var source = """
            package App
            import System
            import System.Collections.Generic

            let m = List[List[int32]]{ List[int32]{ 1, 2 }, List[int32]{ 3, 4, 5 } }
            Console.WriteLine(m.Count)
            Console.WriteLine(m[0].Count)
            Console.WriteLine(m[1].Count)
            Console.WriteLine(m[1][2])
            """;

        Assert.Equal("2\n2\n3\n5\n", CompileAndRun(source));
    }

    [Fact]
    public void DictionaryInitializer_WithListValues_Compose()
    {
        // Dictionary[string, List[int32]] with keyed list-initializer
        // values — keys/values bind and convert through the same Add.
        var source = """
            package App
            import System
            import System.Collections.Generic

            let d = Dictionary[string, List[int32]]{ "evens": List[int32]{ 2, 4 }, "odds": List[int32]{ 1, 3, 5 } }
            Console.WriteLine(d.Count)
            Console.WriteLine(d["evens"].Count)
            Console.WriteLine(d["odds"].Count)
            """;

        Assert.Equal("2\n2\n3\n", CompileAndRun(source));
    }

    [Fact]
    public void Initializer_AsExpressionValue_IsUsableInline()
    {
        // The initializer is an expression: its value (the constructed
        // collection) must be usable directly as a member-access target.
        var source = """
            package App
            import System
            import System.Collections.Generic

            Console.WriteLine(List[int32]{ 5, 6, 7, 8 }.Count)
            """;

        Assert.Equal("4\n", CompileAndRun(source));
    }

    [Fact]
    public void NonCollectionType_ReportsGs0369_NotInternalError()
    {
        // A collection initializer on a type with no accessible Add must
        // report the dedicated GS0369 diagnostic, never the GS9998
        // internal-exception class of failure that #479 warned about. The
        // explicit-parens form routes to the collection-initializer binder
        // (the bare `T{...}` form is a struct literal).
        var source = """
            package App
            import System
            import System.Text

            let sb = StringBuilder(){ 1, 2, 3 }
            """;

        var (exit, diagnostics) = CompileExpectingFailure(source);
        Assert.NotEqual(0, exit);
        Assert.Contains("GS0369", diagnostics);
        Assert.DoesNotContain("GS9998", diagnostics);
    }

    private static string CompileAndRun(string source)
    {
        var (exit, output, diagnostics) = Compile(source, run: true);
        Assert.True(exit == 0, $"compile/run failed ({exit}): {diagnostics}");
        return output;
    }

    private static (int Exit, string Diagnostics) CompileExpectingFailure(string source)
    {
        var (exit, _, diagnostics) = Compile(source, run: false);
        return (exit, diagnostics);
    }

    private static (int Exit, string Output, string Diagnostics) Compile(string source, bool run)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue479_").FullName;
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

            var diagnostics = compileOut.ToString() + compileErr.ToString();
            if (compileExit != 0 || !run)
            {
                return (compileExit, string.Empty, diagnostics);
            }

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

            return (0, stdout.Replace("\r\n", "\n"), diagnostics);
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
