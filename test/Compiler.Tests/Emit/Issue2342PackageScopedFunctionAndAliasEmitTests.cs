// <copyright file="Issue2342PackageScopedFunctionAndAliasEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2342 follow-up: two deferred package-isolation gaps beyond the
/// original struct/enum/interface/delegate/alias-to-real-type declaration fix.
/// <list type="number">
/// <item><description>Top-level FREE FUNCTIONS shared one flat, package-blind
/// overload-set table, so two unrelated packages with a same-simple-name,
/// same-signature free function collided as a spurious duplicate overload
/// (<c>GS0264</c>) — or, if only the declaration check were fixed, a call
/// site inside one package's OWN method body could still silently resolve to
/// the OTHER package's same-name function.</description></item>
/// <item><description>A plain <c>type Name = Target</c> alias's package
/// identity was inferred (best-effort) from its TARGET's package — <see
/// langword="null"/> for a primitive — so two unrelated packages aliasing a
/// primitive under the same simple name collided as a spurious
/// <c>GS0102</c>.</description></item>
/// </list>
/// These tests compile real multi-file, multi-package sources through the
/// full <c>gsc</c> pipeline (parse → bind → lower → emit), ilverify the
/// result, then load and EXECUTE the emitted methods / inspect the emitted
/// field types via reflection to prove runtime correctness, not just
/// successful compilation.
/// </summary>
public class Issue2342PackageScopedFunctionAndAliasEmitTests
{
    [Fact]
    public void UnrelatedPackages_SameSimpleName_SameSignature_FreeFunction_EachPackageResolvesItsOwn()
    {
        // Package "Foo" and package "Baz" each declare their OWN free
        // function `Describe()` with the SAME signature, and their OWN
        // `Worker` class whose method body calls `Describe()` by
        // unqualified simple name. Before this fix: GS0264 duplicate-overload
        // at compile time (or, if only declaration were fixed, `Baz`'s
        // `Worker.Build()` could resolve to `Foo`'s `Describe` and return the
        // wrong string).
        const string fooSource = """
            package Foo

            func Describe() string {
                return "Foo"
            }

            class Worker {
                func Build() string {
                    return Describe()
                }
            }
            """;

        const string bazSource = """
            package Baz

            func Describe() string {
                return "Baz"
            }

            class Worker {
                func Build() string {
                    return Describe()
                }
            }
            """;

        var asm = CompileToLibrary(fooSource, bazSource);

        var workers = asm.GetTypes().Where(t => t.Name == "Worker").ToList();
        Assert.Equal(2, workers.Count);

        var fooWorker = workers.Single(t => t.Namespace == "Foo");
        var bazWorker = workers.Single(t => t.Namespace == "Baz");

        var fooInstance = Activator.CreateInstance(fooWorker);
        var fooResult = (string)fooWorker.GetMethod("Build")!.Invoke(fooInstance, null)!;
        Assert.Equal("Foo", fooResult);

        var bazInstance = Activator.CreateInstance(bazWorker);
        var bazResult = (string)bazWorker.GetMethod("Build")!.Invoke(bazInstance, null)!;
        Assert.Equal("Baz", bazResult);
    }

    [Fact]
    public void SamePackage_DuplicateSignature_FreeFunction_AcrossFiles_StillFailsToCompile()
    {
        // Negative control: the SAME package's genuine duplicate-signature
        // free function, split across two files, must still be rejected.
        const string fileA = """
            package Foo

            func Describe() string {
                return "A"
            }
            """;

        const string fileB = """
            package Foo

            func Describe() string {
                return "B"
            }
            """;

        var errors = CompileExpectingErrors(fileA, fileB);
        Assert.Contains(errors, l => l.Contains("GS0264"));
    }

    [Fact]
    public void UnrelatedPackages_SameSimpleName_PrimitiveAliasedAlias_EachPackageResolvesItsOwn()
    {
        // The exact alias defect: both packages alias a target with NO
        // package identity of its own (a primitive), under the same simple
        // name `Coord`, to a DIFFERENT primitive each. Each package's own
        // struct field typed through its own `Coord` must emit with ITS OWN
        // aliased primitive type, not collide with — or silently borrow —
        // the other package's alias.
        const string fooSource = """
            package Foo

            type Coord = int32

            class Widget {
                var X Coord
            }
            """;

        const string bazSource = """
            package Baz

            type Coord = int64

            class Widget {
                var Y Coord
            }
            """;

        var asm = CompileToLibrary(fooSource, bazSource);

        var widgets = asm.GetTypes().Where(t => t.Name == "Widget").ToList();
        Assert.Equal(2, widgets.Count);

        var fooWidget = widgets.Single(t => t.Namespace == "Foo");
        var bazWidget = widgets.Single(t => t.Namespace == "Baz");

        var xField = fooWidget.GetField("X", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(xField);
        Assert.Equal(typeof(int), xField!.FieldType);

        var yField = bazWidget.GetField("Y", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(yField);
        Assert.Equal(typeof(long), yField!.FieldType);
    }

    [Fact]
    public void SamePackage_DuplicateAlias_AcrossFiles_StillFailsToCompile()
    {
        // Negative control: the SAME package's genuine duplicate alias, split
        // across two files, must still be rejected.
        const string fileA = """
            package Foo

            type Coord = int32
            """;

        const string fileB = """
            package Foo

            type Coord = int64
            """;

        var errors = CompileExpectingErrors(fileA, fileB);
        Assert.Contains(errors, l => l.Contains("GS0102"));
    }

    private static Assembly CompileToLibrary(params string[] sources)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2342_fn_alias_lib_").FullName;
        var srcPaths = new string[sources.Length];
        for (var i = 0; i < sources.Length; i++)
        {
            srcPaths[i] = Path.Combine(tempDir, $"test{i}.gs");
            File.WriteAllText(srcPaths[i], sources[i]);
        }

        var outPath = Path.Combine(tempDir, "test.dll");

        var args = new[]
        {
            "/out:" + outPath,
            "/target:library",
            "/targetframework:net10.0",
        }.Concat(srcPaths).ToArray();

        var compileExit = RunCompiler(args, out var compileOut, out var compileErr);
        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

        IlVerifier.Verify(outPath);
        return Assembly.Load(File.ReadAllBytes(outPath));
    }

    private static System.Collections.Generic.List<string> CompileExpectingErrors(params string[] sources)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2342_fn_alias_err_").FullName;
        try
        {
            var srcPaths = new string[sources.Length];
            for (var i = 0; i < sources.Length; i++)
            {
                srcPaths[i] = Path.Combine(tempDir, $"test{i}.gs");
                File.WriteAllText(srcPaths[i], sources[i]);
            }

            var outPath = Path.Combine(tempDir, "test.dll");

            var args = new[]
            {
                "/out:" + outPath,
                "/target:library",
                "/targetframework:net10.0",
            }.Concat(srcPaths).ToArray();

            var compileExit = RunCompiler(args, out var compileOut, out var compileErr);
            Assert.True(compileExit != 0, "expected gsc to report errors but it succeeded");

            var combined = compileOut + compileErr;
            return combined.Split('\n').Where(l => !string.IsNullOrWhiteSpace(l)).ToList();
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static int RunCompiler(string[] args, out string stdout, out string stderr)
    {
        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        try
        {
            var exit = Program.Main(args);
            stdout = compileOut.ToString();
            stderr = compileErr.ToString();
            return exit;
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }
    }
}
