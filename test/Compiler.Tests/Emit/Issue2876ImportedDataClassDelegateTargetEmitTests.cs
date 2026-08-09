// <copyright file="Issue2876ImportedDataClassDelegateTargetEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2876 — a lambda flowing into a non-<c>Func</c>/<c>Action</c> delegate
/// parameter (<c>Predicate[T]</c>, <c>Comparison[T]</c>) of a GENERIC method
/// closed over an IMPORTED <c>data class</c> materialised the natural
/// <c>Func</c>/<c>Action</c> shape instead of the requested delegate, producing
/// unverifiable IL (<c>ilverify StackUnexpected: [found ref System.Func`2&lt;T,bool&gt;]
/// [expected ref System.Predicate`1&lt;T&gt;]</c>) with no diagnostic.
/// <para>
/// <c>ReflectionMetadataEmitter.ArgIsSymbolicUserDefined</c> answered
/// <see langword="true"/> for ANY <c>StructSymbol</c>. An imported data type's
/// semantic aggregate is also a <c>StructSymbol</c> (see
/// <c>ImportedTypeSymbol.BuildSemanticAggregate</c>, which passes
/// <c>clrType: type</c>), so the lambda's whole function type looked symbolic
/// and <c>EmitFunctionToDelegateConversion</c> discarded the real target
/// delegate in favour of the natural <c>Func</c>/<c>Action</c> shape.
/// Symbolic encoding is only needed when there is no CLR type to reflect over,
/// i.e. <c>ClrType == null</c> — the same guard
/// <c>TypeSymbol.IsSameCompilationUserTypeTopLevel</c> already applies to these
/// four symbol kinds.
/// </para>
/// <para>
/// Every fact here runs <c>ilverify</c> over the produced assembly (see
/// <c>RunBuilt</c>), which is what actually catches the regression.
/// </para>
/// </summary>
public class Issue2876ImportedDataClassDelegateTargetEmitTests
{
    /// <summary>
    /// The generic helpers reused by most facts. <c>Predicate[T]</c> and
    /// <c>Comparison[T]</c> are the broken shapes; <c>Func[T, bool]</c> is the
    /// natural shape that always worked.
    /// </summary>
    private const string HelpersLibrary = """
        package i2876lib

        import System
        import System.Collections.Generic

        public data class Item(Asin string, Title string)

        public class PlainItem {
            public var Asin string

            init(asin string) {
                this.Asin = asin
            }
        }

        public class Filters {
            shared {
                func CountMatching[T](items IEnumerable[T], p Predicate[T]) int32 {
                    var n = 0
                    for item in items {
                        if p.Invoke(item) {
                            n = n + 1
                        }
                    }

                    return n
                }

                func Order[T](a T, b T, c Comparison[T]) int32 {
                    return c.Invoke(a, b)
                }

                func CountFunc[T](items IEnumerable[T], p Func[T, bool]) int32 {
                    var n = 0
                    for item in items {
                        if p.Invoke(item) {
                            n = n + 1
                        }
                    }

                    return n
                }
            }
        }
        """;

    [Fact]
    public void LambdaToGenericPredicateParameter_OverImportedDataClass_Verifies()
    {
        const string source = """
            package i2876a

            import System
            import System.Collections.Generic
            import i2876lib

            func Main() {
                let items = List[Item]()
                items.Add(Item("A1", "One"))
                items.Add(Item("A2", "Two"))
                Console.WriteLine(Filters.CountMatching(items, (i Item) -> i.Asin == "A1"))
            }
            """;

        Assert.Equal($"1{Environment.NewLine}", CompileAndRun(source, HelpersLibrary, "i2876lib"));
    }

    [Fact]
    public void LambdaToGenericComparisonParameter_OverImportedDataClass_Verifies()
    {
        const string source = """
            package i2876b

            import System
            import i2876lib

            func Main() {
                Console.WriteLine(Filters.Order(Item("A1", "One"), Item("A2", "Two"), (x Item, y Item) -> String.Compare(x.Asin, y.Asin)))
            }
            """;

        Assert.Equal($"-1{Environment.NewLine}", CompileAndRun(source, HelpersLibrary, "i2876lib"));
    }

    [Fact]
    public void LambdaToGenericFuncParameter_OverImportedDataClass_StillVerifies()
    {
        // Control: `Func`/`Action` are the natural structural delegate shapes,
        // so this arm was never affected.
        const string source = """
            package i2876c

            import System
            import System.Collections.Generic
            import i2876lib

            func Main() {
                let items = List[Item]()
                items.Add(Item("A1", "One"))
                items.Add(Item("A2", "Two"))
                Console.WriteLine(Filters.CountFunc(items, (i Item) -> i.Asin == "A2"))
            }
            """;

        Assert.Equal($"1{Environment.NewLine}", CompileAndRun(source, HelpersLibrary, "i2876lib"));
    }

    [Fact]
    public void LambdaToGenericPredicateParameter_OverImportedPlainClass_StillVerifies()
    {
        // Control: a plain imported class is an ImportedTypeSymbol, never a
        // StructSymbol, so it never tripped the symbolic gate.
        const string source = """
            package i2876d

            import System
            import System.Collections.Generic
            import i2876lib

            func Main() {
                let items = List[PlainItem]()
                items.Add(PlainItem("P1"))
                items.Add(PlainItem("P2"))
                Console.WriteLine(Filters.CountMatching(items, (p PlainItem) -> p.Asin == "P1"))
            }
            """;

        Assert.Equal($"1{Environment.NewLine}", CompileAndRun(source, HelpersLibrary, "i2876lib"));
    }

    [Fact]
    public void LambdaToGenericPredicateParameter_OverLocalDataClass_StillVerifies()
    {
        // Control: a SAME-COMPILATION data class genuinely has no CLR type, so
        // it must keep taking the symbolic path.
        const string source = """
            package i2876e

            import System
            import System.Collections.Generic
            import i2876lib

            data class Local(Key string)

            func Main() {
                let items = List[Local]()
                items.Add(Local("L1"))
                items.Add(Local("L2"))
                Console.WriteLine(Filters.CountMatching(items, (l Local) -> l.Key == "L2"))
            }
            """;

        Assert.Equal($"1{Environment.NewLine}", CompileAndRun(source, HelpersLibrary, "i2876lib"));
    }

    [Fact]
    public void MethodGroupToGenericPredicateParameter_OverImportedDataClass_Verifies()
    {
        // A method group materialises through the same
        // EmitFunctionToDelegateConversion entry point as a lambda.
        const string source = """
            package i2876f

            import System
            import System.Collections.Generic
            import i2876lib

            func IsFirst(i Item) bool {
                return i.Asin == "A1"
            }

            func Main() {
                let items = List[Item]()
                items.Add(Item("A1", "One"))
                items.Add(Item("A2", "Two"))
                Console.WriteLine(Filters.CountMatching(items, IsFirst))
            }
            """;

        Assert.Equal($"1{Environment.NewLine}", CompileAndRun(source, HelpersLibrary, "i2876lib"));
    }

    private static string CompileAndRun(string source, string library, string libraryAssemblyName)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2876_").FullName;
        try
        {
            var dllPath = BuildExecutable(tempDir, source, library, libraryAssemblyName, out var libDll);

            var rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json");
            if (!File.Exists(rtConfig))
            {
                File.WriteAllText(rtConfig, """
                    {
                      "runtimeOptions": {
                        "tfm": "net10.0",
                        "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                      }
                    }
                    """);
            }

            IlVerifier.Verify(dllPath, libDll != null ? new[] { libDll } : null);

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(rtConfig);
            psi.ArgumentList.Add(dllPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch (IOException)
            {
            }
        }
    }

    private static string BuildExecutable(
        string tempDir,
        string source,
        string library,
        string libraryAssemblyName,
        out string libDll)
    {
        // ilverify resolves `-r` references by FILE NAME, so the library must
        // be written out under its assembly identity.
        var libSrc = Path.Combine(tempDir, libraryAssemblyName + ".gs");
        libDll = Path.Combine(tempDir, libraryAssemblyName + ".dll");
        File.WriteAllText(libSrc, library);

        Compile(new[]
        {
            "/out:" + libDll,
            "/target:library",
            "/targetframework:net10.0",
            libSrc,
        });
        IlVerifier.Verify(libDll);

        var srcPath = Path.Combine(tempDir, "test.gs");
        var dllPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        Compile(new[]
        {
            "/out:" + dllPath,
            "/target:exe",
            "/targetframework:net10.0",
            "/r:" + libDll,
            srcPath,
        });

        return dllPath;
    }

    private static void Compile(string[] args)
    {
        using var stdoutWriter = new StringWriter();
        using var stderrWriter = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(stdoutWriter);
        Console.SetError(stderrWriter);
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
            $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");
    }
}
