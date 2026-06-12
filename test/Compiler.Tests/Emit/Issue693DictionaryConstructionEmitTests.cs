// <copyright file="Issue693DictionaryConstructionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// End-to-end emit tests for issue #693 — multi-type-arg CLR generic
/// construction via <c>Dictionary[K, V]()</c> (and friends) compiles,
/// IL-verifies, and runs.
/// <para>
/// PR #690's "out-of-scope" note claimed <c>Dictionary[K, V]()</c> was
/// "shadowed by the map-literal parser" and worked around it with
/// <c>KeyValuePair[K, V](k, v)</c>. Investigation against the current
/// parser (see <c>Issue693MultiTypeArgGenericCallParserTests</c>) shows
/// the ADR-0020 bounded-lookahead disambiguation already handles the
/// multi-type-arg shape correctly — <c>LooksLikeGenericCallSite</c>
/// scans an arbitrary comma-separated type-clause list inside the
/// brackets and commits to a generic call when the follow-set token is
/// <c>(</c>, <c>{</c>, or <c>.</c>. These tests lock that contract in at
/// the emit layer (parse + bind + emit + ilverify + execute), covering
/// the specific cases the PR-#690 workaround left untested:
/// <c>Dictionary[K, V]()</c> with primitives, with G# user-defined
/// classes as one or both type arguments, deeply-nested generics, and
/// the sibling generic dictionaries <c>SortedDictionary[K, V]</c> and
/// <c>ConcurrentDictionary[K, V]</c>.
/// </para>
/// </summary>
public class Issue693DictionaryConstructionEmitTests
{
    [Fact]
    public void Construct_DictionaryOfStringInt32_Compiles_And_Runs()
    {
        // Smallest direct emit test for the case PR #690 deferred. Empty
        // construction followed by Add + Count read on the constructed
        // generic. Mirrors the existing List[int32]() regression in
        // Issue671ConstructionCallEmitTests but exercises a two-type-arg
        // BCL generic instead of a one-type-arg one.
        var source = """
            package App
            import System
            import System.Collections.Generic

            let d = Dictionary[string, int32]()
            d.Add("a", 1)
            d.Add("b", 2)
            Console.WriteLine(d.Count)
            """;

        Assert.Equal("2\n", CompileAndRun(source));
    }

    [Fact]
    public void Construct_DictionaryOfStringToUserClass_Compiles_And_Runs()
    {
        // Direct coverage for the case the PR #690 workaround left
        // untested: a multi-type-arg generic ctor where one of the type
        // arguments is a G# user-defined class. KeyValuePair[string, MyGs]
        // already covered the binder/emit code path; this test does the
        // same on Dictionary[string, MyGs] so the regression is named
        // after the actual API users construct.
        var source = """
            package App
            import System
            import System.Collections.Generic

            class MyGs {
                var Name string = ""
            }

            let d = Dictionary[string, MyGs]()
            d.Add("first", MyGs())
            d.Add("second", MyGs())
            Console.WriteLine(d.Count)
            """;

        Assert.Equal("2\n", CompileAndRun(source));
    }

    [Fact]
    public void Construct_DictionaryOfUserClassToUserClass_Compiles_And_Runs()
    {
        // Both type arguments are G# user-defined classes. Exercises the
        // symbolic-container plumbing (PR #690) end-to-end for the
        // Dictionary ctor's two-type-arg shape and the keyed Add lookup
        // on the constructed symbolic parent.
        var source = """
            package App
            import System
            import System.Collections.Generic

            class K {
                var N int32 = 0
            }

            class V {
                var N int32 = 0
            }

            let d = Dictionary[K, V]()
            d.Add(K(), V())
            Console.WriteLine(d.Count)
            """;

        Assert.Equal("1\n", CompileAndRun(source));
    }

    [Fact]
    public void Construct_DictionaryAsFieldInitializer_Compiles_And_Runs()
    {
        // Dictionary[K, V]() as a default field initializer on a class
        // — the field type is `Dictionary[string, MyGs]` and the
        // initializer is the same multi-type-arg ctor call. Hits the
        // class-init-time emission path for ctor calls with user-class
        // type args.
        var source = """
            package App
            import System
            import System.Collections.Generic

            class MyGs {
                var Name string = ""
            }

            class Holder {
                var Map Dictionary[string, MyGs] = Dictionary[string, MyGs]()
            }

            let h = Holder()
            h.Map.Add("a", MyGs())
            Console.WriteLine(h.Map.Count)
            """;

        Assert.Equal("1\n", CompileAndRun(source));
    }

    [Fact]
    public void Construct_DictionaryChainedMemberAccess_Compiles_And_Runs()
    {
        // ADR-0020 follow-set: `.` after `Type[T1, T2]` is a member
        // access on the constructed type. Tests the chained-postfix
        // shape `Dictionary[string, int32]().Count` parses, binds, and
        // emits correctly when used inline as a function argument.
        var source = """
            package App
            import System
            import System.Collections.Generic

            Console.WriteLine(Dictionary[string, int32]().Count)
            """;

        Assert.Equal("0\n", CompileAndRun(source));
    }

    [Fact]
    public void Construct_SortedDictionaryOfStringInt32_Compiles_And_Runs()
    {
        // SortedDictionary is the same shape as Dictionary at the parser
        // level (`Identifier [TypeArg, TypeArg] ()`); this confirms the
        // disambiguation is generic across any two-type-arg BCL generic,
        // not just the well-known Dictionary identifier.
        var source = """
            package App
            import System
            import System.Collections.Generic

            let d = SortedDictionary[string, int32]()
            d.Add("b", 2)
            d.Add("a", 1)
            Console.WriteLine(d.Count)
            """;

        Assert.Equal("2\n", CompileAndRun(source));
    }

    [Fact]
    public void Construct_ConcurrentDictionaryOfStringInt32_Compiles_And_Runs()
    {
        // ConcurrentDictionary lives in System.Collections.Concurrent —
        // distinct namespace, same parser/binder/emit pipeline as
        // Dictionary. Verifies the multi-type-arg construction works
        // for a generic from a different namespace.
        var source = """
            package App
            import System
            import System.Collections.Concurrent

            let d = ConcurrentDictionary[string, int32]()
            d.TryAdd("a", 1)
            Console.WriteLine(d.Count)
            """;

        Assert.Equal("1\n", CompileAndRun(source));
    }

    [Fact]
    public void Construct_DictionaryWithNestedListValue_Compiles_And_Runs()
    {
        // Dictionary[string, List[int32]]() — the second type argument
        // is itself a constructed generic. Exercises the recursive
        // type-clause-scan path inside the multi-type-arg disambiguation
        // (each nested `[` opens a fresh tentative type-argument list).
        var source = """
            package App
            import System
            import System.Collections.Generic

            let d = Dictionary[string, List[int32]]()
            d.Add("a", List[int32]())
            d["a"].Add(1)
            d["a"].Add(2)
            Console.WriteLine(d["a"].Count)
            """;

        Assert.Equal("2\n", CompileAndRun(source));
    }

    [Fact]
    public void Construct_DictionaryWithNestedDictionaryValue_Compiles_And_Runs()
    {
        // Dictionary[string, Dictionary[string, int32]]() — three
        // brackets deep on the second type arg. Two-type-arg nested
        // inside another two-type-arg, the most challenging case for the
        // recursive type-clause scan.
        var source = """
            package App
            import System
            import System.Collections.Generic

            let d = Dictionary[string, Dictionary[string, int32]]()
            d.Add("a", Dictionary[string, int32]())
            d["a"].Add("x", 1)
            d["a"].Add("y", 2)
            Console.WriteLine(d["a"].Count)
            """;

        Assert.Equal("2\n", CompileAndRun(source));
    }

    [Fact]
    public void Construct_QualifiedDictionaryOfStringInt32_Compiles_And_Runs()
    {
        // Qualified form `System.Collections.Generic.Dictionary[K, V]()`
        // — the qualified-name binder path also accepts multi-type-arg
        // construction. PR #690 added the qualified-construction path
        // for user-defined type args; this regression locks the simple
        // primitive-arg shape in.
        var source = """
            package App
            import System

            let d = System.Collections.Generic.Dictionary[string, int32]()
            d.Add("a", 1)
            Console.WriteLine(d.Count)
            """;

        Assert.Equal("1\n", CompileAndRun(source));
    }

    [Fact]
    public void Regression_MapLiteralStillCompilesAndRuns()
    {
        // Negative regression: G#'s `map[K]V{...}` literal syntax must
        // continue to work alongside the multi-type-arg Dictionary
        // construction. The disambiguation only triggers on an
        // identifier-headed `[`, so the `map` keyword path is untouched.
        var source = """
            package App
            import System

            let m = map[string]int32 { "a": 1, "b": 2 }
            Console.WriteLine(len(m))
            """;

        Assert.Equal("2\n", CompileAndRun(source));
    }

    [Fact]
    public void Regression_SingleTypeArgListCtorStillCompilesAndRuns()
    {
        // Sanity regression: the existing single-type-arg ctor (List[T]())
        // continues to parse, bind, and emit correctly through the same
        // disambiguation path that now handles the multi-type-arg case.
        var source = """
            package App
            import System
            import System.Collections.Generic

            let xs = List[int32]()
            xs.Add(1)
            xs.Add(2)
            xs.Add(3)
            Console.WriteLine(xs.Count)
            """;

        Assert.Equal("3\n", CompileAndRun(source));
    }

    [Fact]
    public void Regression_KeyValuePairMultiArgCtorStillCompilesAndRuns()
    {
        // Sanity regression: the indirect KeyValuePair-based coverage
        // used by PR #690 to skirt the deferred Dictionary case must
        // still work, so this PR does not regress the multi-type-arg
        // construction path on a sibling generic.
        var source = """
            package App
            import System
            import System.Collections.Generic

            class MyGs {
                var Name string = ""
            }

            let kvp = KeyValuePair[string, MyGs]("k", MyGs())
            Console.WriteLine(kvp.Key)
            """;

        Assert.Equal("k\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue693_dict_").FullName;
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
