// <copyright file="Issue3880IndexedCallableMemberEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3880: ADR-0020's follow-set rule commits <c>X.Member[i](args)</c> to
/// a generic call site, and indexer-then-invoke was never reconsidered — so a
/// dictionary of factories (<c>GNodeSamples.All[type]()</c> in the migrated
/// <c>tools/cs2gs/Cs2Gs.Tests</c>) reported GS0158/GS0159 while the identical
/// <c>let f = GNodeSamples.All[type]</c> followed by <c>f()</c> bound fine.
/// The binder now falls back to the indexed reading, but only where the
/// generic reading has already failed, the bracket holds a bare identifier
/// (the one genuinely ambiguous shape), and the member really is a value.
/// Pinned end to end so the emitted call is executed, not merely bound.
/// </summary>
public class Issue3880IndexedCallableMemberEmitTests
{
    [Fact]
    public void IndexedCallableMember_InvokesThroughStaticAndInstanceReceivers()
    {
        var output = CompileAndRun("""
            package P
            import System
            import System.Collections.Generic

            class Samples {
                shared {
                    let All Dictionary[Type, Func[string]] = Dictionary[Type, Func[string]]()
                    func Seed() {
                        All[typeof(string)] = func() string { return "made-string" }
                    }
                }
            }

            class Box {
                var Table Dictionary[string, Func[int32, string]] = Dictionary[string, Func[int32, string]]()
                var Rows []Func[string] = []Func[string]{}
            }

            class Generic {
                shared {
                    func Make[T]() string { return typeof(T).Name }
                }
            }

            func Main() {
                Samples.Seed()
                let t = typeof(string)

                // Static receiver, indexer then invoke.
                Console.WriteLine(Samples.All[t]())

                // The un-invoked form has always worked; it must keep working.
                let f = Samples.All[t]
                Console.WriteLine(f())

                // Instance receiver, indexer then invoke — with an argument.
                let b = Box()
                let key = "k"
                b.Table[key] = func(n int32) string { return "n=" + n.ToString() }
                Console.WriteLine(b.Table[key](7))

                // An array-typed member indexed by a local, then invoked.
                b.Rows = []Func[string]{func() string { return "row0" }}
                let i = 0
                Console.WriteLine(b.Rows[i]())

                // The GENERIC reading must still win where it is the real one.
                Console.WriteLine(Generic.Make[int32]())
            }
            """);

        Assert.Equal(
            "made-string" + Environment.NewLine
                + "made-string" + Environment.NewLine
                + "n=7" + Environment.NewLine
                + "row0" + Environment.NewLine
                + "Int32" + Environment.NewLine,
            output);
    }

    [Fact]
    public void UnresolvableTypeArgumentOnAGenericMethod_StillReportsItsOwnDiagnostic()
    {
        // The recovery must not swallow the diagnostic for a genuine bad type
        // argument: it only fires when the receiver really has a value member
        // of that name.
        var errors = CompileExpectingErrors("""
            package P
            import System

            class Holder {
                func Pick[T]() string { return typeof(T).Name }
                shared {
                    func Make[T]() string { return typeof(T).Name }
                }
            }

            func Main() {
                let h = Holder()
                Console.WriteLine(h.Pick[NotAType]())
                Console.WriteLine(Holder.Make[AlsoNotAType]())
            }
            """);

        Assert.Contains("GS0113", errors, StringComparison.Ordinal);
        Assert.Contains("NotAType", errors, StringComparison.Ordinal);
        Assert.Contains("AlsoNotAType", errors, StringComparison.Ordinal);
    }

    [Fact]
    public void IndexedNamedDelegate_KeepsVariadicAndNamedArgumentSupport()
    {
        // Review finding on PR #3966: the first revision converted the
        // arguments itself with an exact-arity check and a plain by-value
        // loop, so anything the canonical argument binders handle — variadic
        // packing, optional/named arguments, ref-kind metadata — was lost.
        // `b.Named[k](",", "a", "b", "c")` (arity 2, four arguments) reported
        // GS0159. The indexed value now REPLACES the callable and falls
        // through to the same machinery the non-indexed delegate member uses.
        var output = CompileAndRun("""
            package P
            import System
            import System.Collections.Generic

            delegate Joiner(sep string, parts ...string) string;

            class Box {
                var Named Dictionary[string, Joiner] = Dictionary[string, Joiner]()
            }

            func Main() {
                let b = Box()
                let k = "k"
                b.Named[k] = func(sep string, parts ...string) string { return string.Join(sep, parts) }
                Console.WriteLine(b.Named[k](",", "a", "b", "c"))
                Console.WriteLine(b.Named[k]("-"))
            }
            """);

        Assert.Equal($"a,b,c{Environment.NewLine}{Environment.NewLine}", output);
    }

    [Fact]
    public void IndexedCallableMember_WorksThroughAnImportedReceiver()
    {
        // Review finding on PR #3966: the parser ambiguity is receiver-agnostic,
        // so the recovery must not depend on whether the receiver's type was
        // declared in this compilation. Before the fix this exact consumer
        // reported GS0159 + a misleading GS0113 ("Type 'k' doesn't exist" for a
        // local variable) purely because `Registry` came from a reference.
        var output = CompileLibraryAndRun(
            library: """
                package LibIndexed
                import System
                import System.Collections.Generic

                class Registry {
                    var Callbacks Dictionary[string, Func[string]] = Dictionary[string, Func[string]]()
                }
                """,
            consumer: """
                package P
                import System
                import System.Collections.Generic
                import LibIndexed

                func Main() {
                    let r = Registry()
                    let k = "k"
                    r.Callbacks[k] = func() string { return "from-imported" }
                    Console.WriteLine(r.Callbacks[k]())
                }
                """);

        Assert.Equal($"from-imported{Environment.NewLine}", output);
    }

    private static string CompileLibraryAndRun(string library, string consumer)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3880_indexed_lib_").FullName;
        try
        {
            var libSrc = Path.Combine(tempDir, "lib.gs");

            // ilverify resolves a reference by SIMPLE ASSEMBLY NAME against the
            // file name, so the output file has to be named for the package or
            // the consumer fails to verify with FileLoadErrorGeneric.
            var libDll = Path.Combine(tempDir, "LibIndexed.dll");
            File.WriteAllText(libSrc, library);
            RunGsc(new[] { "/out:" + libDll, "/target:library", "/targetframework:net10.0", libSrc });

            var consumerSrc = Path.Combine(tempDir, "consumer.gs");
            var consumerDll = Path.Combine(tempDir, "consumer.dll");
            File.WriteAllText(consumerSrc, consumer);
            RunGsc(new[]
            {
                "/out:" + consumerDll,
                "/target:exe",
                "/targetframework:net10.0",
                "/r:" + libDll,
                consumerSrc,
            });
            IlVerifier.Verify(consumerDll, new[] { libDll });

            var psi = new System.Diagnostics.ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(consumerDll, ".runtimeconfig.json"));
            psi.ArgumentList.Add(consumerDll);

            using var proc = System.Diagnostics.Process.Start(psi)!;
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(proc.ExitCode == 0, $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
            return stdout.ReplaceLineEndings(Environment.NewLine);
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

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3880_indexed_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);
            RunGsc(new[] { "/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath });
            IlVerifier.Verify(outPath);

            var psi = new System.Diagnostics.ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(outPath);

            using var proc = System.Diagnostics.Process.Start(psi)!;
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(proc.ExitCode == 0, $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
            return stdout.ReplaceLineEndings(Environment.NewLine);
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

    private static string CompileExpectingErrors(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3880_indexed_neg_").FullName;
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
                compileExit = Program.Main(new[] { "/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath });
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(compileExit != 0, "the bad type arguments should still fail the compile");
            return compileOut.ToString() + compileErr.ToString();
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

    private static void RunGsc(string[] args)
    {
        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(args);
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
    }
}
