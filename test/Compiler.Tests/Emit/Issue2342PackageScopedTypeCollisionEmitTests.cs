// <copyright file="Issue2342PackageScopedTypeCollisionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2342: two top-level types (or a whole "shape" of colliding symbol
/// kinds) that share a simple name across DIFFERENT packages must not collide
/// with <c>GS0102</c>, must both emit as distinct CLR types (namespace-qualified
/// by their own <c>PackageName</c>), and — critically — each package's OWN
/// method bodies must keep resolving their OWN same-simple-name type by
/// unqualified reference rather than the first-declared package's homonym
/// (the cascading <c>GS0158</c> symptom described in the issue). These tests
/// compile real multi-file, multi-package sources through the full <c>gsc</c>
/// pipeline (parse → bind → lower → emit), ilverify the result, then load and
/// EXECUTE the emitted methods via reflection to prove runtime correctness,
/// not just successful compilation.
/// </summary>
public class Issue2342PackageScopedTypeCollisionEmitTests
{
    [Fact]
    public void UnrelatedPackages_SameSimpleNames_EmitDistinctTypes_AndEachPackageResolvesItsOwn()
    {
        // Package "Foo" and package "Baz" each declare their OWN `Shape0` data
        // shape and their OWN `Worker` class whose method body constructs an
        // object literal of ITS OWN package's `Shape0` by unqualified simple
        // name. Before the #2342 fix this failed to compile at all (GS0102 on
        // the second `Shape0`/`Worker`); after fixing only the declaration
        // check (without the ambient-package lookup fix), the second
        // package's method body would resolve `Shape0` to the FIRST package's
        // (wrong-shape) type and cascade GS0158. This test proves both the
        // declaration collision AND the lookup ambiguity are fixed together.
        const string fooSource = """
            package Foo

            class Shape0 {
                var Name string
            }

            class Worker {
                func Build() string {
                    let s = Shape0{Name: "foo-shape"}
                    return s.Name
                }
            }
            """;

        const string bazSource = """
            package Baz

            class Shape0 {
                var Width int32
            }

            class Worker {
                func Build() int32 {
                    let s = Shape0{Width: 42}
                    return s.Width
                }
            }
            """;

        var asm = CompileToLibrary(fooSource, bazSource);

        var shapes = asm.GetTypes().Where(t => t.Name == "Shape0").ToList();
        Assert.Equal(2, shapes.Count);
        Assert.Contains(shapes, t => t.Namespace == "Foo");
        Assert.Contains(shapes, t => t.Namespace == "Baz");

        var workers = asm.GetTypes().Where(t => t.Name == "Worker").ToList();
        Assert.Equal(2, workers.Count);

        var fooWorker = workers.Single(t => t.Namespace == "Foo");
        var bazWorker = workers.Single(t => t.Namespace == "Baz");

        var fooInstance = Activator.CreateInstance(fooWorker);
        var fooResult = (string)fooWorker.GetMethod("Build")!.Invoke(fooInstance, null)!;
        Assert.Equal("foo-shape", fooResult);

        var bazInstance = Activator.CreateInstance(bazWorker);
        var bazResult = (int)bazWorker.GetMethod("Build")!.Invoke(bazInstance, null)!;
        Assert.Equal(42, bazResult);
    }

    [Fact]
    public void PrefixPackages_FooAndFooBar_SameSimpleName_EmitDistinctTypes_AndEachPackageResolvesItsOwn()
    {
        // Companion to the unrelated-packages test above, but with packages
        // that share a dotted prefix ("Foo" vs. "Foo.Bar") — the exact shape
        // that must NOT be conflated with nested-type or same-package
        // semantics.
        const string fooSource = """
            package Foo

            class Widget {
                var A int32
            }

            class Describer {
                func Describe() int32 {
                    let w = Widget{A: 1}
                    return w.A
                }
            }
            """;

        const string fooBarSource = """
            package Foo.Bar

            class Widget {
                var B int32
            }

            class Describer {
                func Describe() int32 {
                    let w = Widget{B: 2}
                    return w.B
                }
            }
            """;

        var asm = CompileToLibrary(fooSource, fooBarSource);

        var widgets = asm.GetTypes().Where(t => t.Name == "Widget").ToList();
        Assert.Equal(2, widgets.Count);
        Assert.Contains(widgets, t => t.Namespace == "Foo");
        Assert.Contains(widgets, t => t.Namespace == "Foo.Bar");

        var describers = asm.GetTypes().Where(t => t.Name == "Describer").ToList();
        Assert.Equal(2, describers.Count);

        var fooDescriber = describers.Single(t => t.Namespace == "Foo");
        var fooBarDescriber = describers.Single(t => t.Namespace == "Foo.Bar");

        var fooInstance = Activator.CreateInstance(fooDescriber);
        var fooResult = (int)fooDescriber.GetMethod("Describe")!.Invoke(fooInstance, null)!;
        Assert.Equal(1, fooResult);

        var fooBarInstance = Activator.CreateInstance(fooBarDescriber);
        var fooBarResult = (int)fooBarDescriber.GetMethod("Describe")!.Invoke(fooBarInstance, null)!;
        Assert.Equal(2, fooBarResult);
    }

    [Fact]
    public void SamePackage_DuplicateSimpleName_AcrossFiles_StillFailsToCompile()
    {
        // Negative control: splitting the SAME package's genuine duplicate
        // across two files must still be rejected with GS0102 — the fix must
        // not accidentally widen same-package duplicate detection.
        const string fileA = """
            package Foo

            class Shape0 {
                var Name string
            }
            """;

        const string fileB = """
            package Foo

            class Shape0 {
                var Width int32
            }
            """;

        var errors = CompileExpectingErrors(fileA, fileB);
        Assert.Contains(errors, l => l.Contains("GS0102"));
    }

    private static Assembly CompileToLibrary(params string[] sources)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2342_lib_").FullName;
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
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2342_err_").FullName;
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
