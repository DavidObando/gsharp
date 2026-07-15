// <copyright file="Issue2342PackageScopedExtensionFunctionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2342 follow-up: extension functions were left package-blind by the
/// earlier free-function/alias follow-up. Two unrelated packages that each
/// declare an extension on a SHARED receiver type (a primitive, which has no
/// package identity of its own) under the same simple name and signature
/// previously collided as a spurious <c>GS0264</c> duplicate overload, and
/// even once the declaration collision was fixed, a call site in one
/// package's own code could still resolve to the OTHER package's same-name,
/// same-signature extension instead of its own. These tests compile real
/// multi-file, multi-package sources through the full <c>gsc</c> pipeline
/// (parse → bind → lower → emit), ilverify the result, then load and EXECUTE
/// the emitted methods via reflection to prove runtime correctness, not just
/// successful compilation.
/// </summary>
public class Issue2342PackageScopedExtensionFunctionEmitTests
{
    [Fact]
    public void UnrelatedPackages_SameSimpleName_SameSignature_ExtensionOnSharedReceiver_EachPackageResolvesItsOwn()
    {
        // Package "Foo" and package "Baz" each declare their OWN extension
        // `Greet()` on the SAME shared receiver type `string`, with the SAME
        // signature, and their OWN `Worker` class whose method body calls
        // `"x".Greet()` by unqualified instance syntax. Before this fix:
        // GS0264 duplicate-overload at compile time (or, if only declaration
        // were fixed, `Baz`'s `Worker.Build()` could resolve to `Foo`'s
        // extension and return the wrong string).
        const string fooSource = """
            package Foo

            func (s string) Greet() string {
                return "Foo:" + s
            }

            class Worker {
                func Build() string {
                    return "x".Greet()
                }
            }
            """;

        const string bazSource = """
            package Baz

            func (s string) Greet() string {
                return "Baz:" + s
            }

            class Worker {
                func Build() string {
                    return "x".Greet()
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
        Assert.Equal("Foo:x", fooResult);

        var bazInstance = Activator.CreateInstance(bazWorker);
        var bazResult = (string)bazWorker.GetMethod("Build")!.Invoke(bazInstance, null)!;
        Assert.Equal("Baz:x", bazResult);
    }

    [Fact]
    public void OwnPackageCall_FromLambdaBody_ResolvesToOwnExtension_AtRuntime()
    {
        // "Calls from deferred/lambda bodies" coverage at the emit/run
        // level: package Baz's own extension call is made from inside a
        // lambda invoked by its method body, not directly in the method's
        // top-level statement list.
        const string fooSource = """
            package Foo

            func (s string) Greet() string {
                return "Foo:" + s
            }
            """;

        const string bazSource = """
            package Baz

            func (s string) Greet() string {
                return "Baz:" + s
            }

            class Worker {
                func Build() string {
                    let f = func() string { return "x".Greet() }
                    return f()
                }
            }
            """;

        var asm = CompileToLibrary(fooSource, bazSource);

        var bazWorker = asm.GetTypes().Single(t => t.Name == "Worker" && t.Namespace == "Baz");
        var bazInstance = Activator.CreateInstance(bazWorker);
        var bazResult = (string)bazWorker.GetMethod("Build")!.Invoke(bazInstance, null)!;
        Assert.Equal("Baz:x", bazResult);
    }

    [Fact]
    public void SamePackage_DuplicateSignature_ExtensionOnSharedReceiver_AcrossFiles_StillFailsToCompile()
    {
        // Negative control: the SAME package's genuine duplicate-signature
        // extension, split across two files, must still be rejected.
        const string fileA = """
            package Foo

            func (s string) Greet() string {
                return "A:" + s
            }
            """;

        const string fileB = """
            package Foo

            func (s string) Greet() string {
                return "B:" + s
            }
            """;

        var errors = CompileExpectingErrors(fileA, fileB);
        Assert.Contains(errors, l => l.Contains("GS0264"));
    }

    [Fact]
    public void CrossPackage_ClrImportedExtension_And_UserExtension_CoexistAtRuntime()
    {
        // Cross-package imports/qualification: a CLR/BCL imported extension
        // method (`System.Linq.Enumerable.Where`) used in one package must
        // coexist peacefully — and both remain independently callable at
        // runtime — with an unrelated user-declared extension of the same
        // simple name on an unrelated receiver type in a different package.
        const string fooSource = """
            package Foo

            import System.Linq
            import System.Collections.Generic

            class Worker {
                func CountEvens() int32 {
                    let list = List[int32]()
                    list.Add(1)
                    list.Add(2)
                    list.Add(3)
                    list.Add(4)
                    let evens = list.Where(func(x int32) bool { return x % 2 == 0 })
                    var count = 0
                    for x in evens {
                        count = count + 1
                    }
                    return count
                }
            }
            """;

        const string bazSource = """
            package Baz

            func (s string) Where() string {
                return "Baz:" + s
            }

            class Worker {
                func Build() string {
                    return "x".Where()
                }
            }
            """;

        var asm = CompileToLibrary(fooSource, bazSource);

        var fooWorker = asm.GetTypes().Single(t => t.Name == "Worker" && t.Namespace == "Foo");
        var fooInstance = Activator.CreateInstance(fooWorker);
        var fooResult = (int)fooWorker.GetMethod("CountEvens")!.Invoke(fooInstance, null)!;
        Assert.Equal(2, fooResult);

        var bazWorker = asm.GetTypes().Single(t => t.Name == "Worker" && t.Namespace == "Baz");
        var bazInstance = Activator.CreateInstance(bazWorker);
        var bazResult = (string)bazWorker.GetMethod("Build")!.Invoke(bazInstance, null)!;
        Assert.Equal("Baz:x", bazResult);
    }

    private static Assembly CompileToLibrary(params string[] sources)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2342_ext_lib_").FullName;
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
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2342_ext_err_").FullName;
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
