// <copyright file="Issue3839RefReturningMemberTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Emit;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3839: the by-ref-ness of a member was lost on the way out of cs2gs,
/// in two different ways with two different verdicts.
/// <list type="number">
/// <item>An expression-bodied <c>ref</c>-returning METHOD kept its <c>ref</c>
/// return type but folded to the G# arrow form with a plain (non-<c>ref</c>)
/// return, which gsc rejects with GS0252. G# genuinely HAS this construct
/// (issue #490 / ADR-0060, block form only), so this is a translator bug and is
/// fixed: the arrow fold is refused for a ref return and the block body carries
/// <c>return ref lvalue</c>.</item>
/// <item>A <c>ref</c> PROPERTY or INDEXER lost its <c>ref</c> entirely and
/// became a copy-returning member — no error anywhere, a pure behaviour change.
/// G# has NO such construct (the by-ref return is a <c>func</c> feature; there
/// is no <c>prop P ref T</c> spelling), so the honest verdict is a loud gap, the
/// same one cs2gs already reaches at the USE site of a ref-returning indexer
/// (#1987). Silently emitting the copy-returning form is the one outcome that
/// must not happen.</item>
/// </list>
/// <para>
/// The method half is proven by EXECUTION, not by printed shape: a printed-shape
/// assertion passes just as happily on a copy-returning member. The translated
/// G# is compiled by gsc and a C# driver writes through the returned reference;
/// the write has to be observable through the original storage.
/// </para>
/// </summary>
public sealed class Issue3839RefReturningMemberTranslationTests
{
    private const string RefMethodSource = """
        namespace Repro
        {
            public class Holder
            {
                private readonly int[] values = new[] { 40, 41, 42 };

                public ref int GetValue(int index) => ref values[index];

                public int Read(int index) => values[index];
            }
        }
        """;

    /// <summary>
    /// The declaration keeps <c>ref</c> AND the returned expression is emitted as
    /// a by-ref return. G#'s arrow form has no <c>-&gt; ref lvalue</c> spelling,
    /// so the member must fall back to the block body.
    /// </summary>
    [Fact]
    public void ExpressionBodiedRefMethod_EmitsBlockBodyWithReturnRef()
    {
        string printed = Translate(RefMethodSource);

        Assert.Contains("ref int32", printed, StringComparison.Ordinal);
        Assert.Contains("return ref values[index]", printed, StringComparison.Ordinal);

        // The defect shape: the arrow form with the `ref` dropped from the
        // returned expression (`func GetValue(index int32) ref int32 ->
        // values[index]`), which gsc rejects with GS0252.
        Assert.DoesNotContain("ref int32 ->", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// Anti-vacuity guard: an ORDINARY expression-bodied method must still fold
    /// to the idiomatic G# arrow form (issue #1278 / ADR-0131). Without this,
    /// "never fold an expression body" would satisfy the test above.
    /// </summary>
    [Fact]
    public void ExpressionBodiedNonRefMethod_StillFoldsToTheArrowForm()
    {
        string printed = Translate("""
            namespace Repro
            {
                public class Plain
                {
                    private readonly int[] values = new[] { 1, 2, 3 };

                    public int Read(int index) => values[index];
                }
            }
            """);

        Assert.Contains("-> values[index]", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// The executing proof. gsc compiles the translated G#; a C# driver takes a
    /// reference through the emitted member, writes 99 through it, and reads the
    /// storage back. A copy-returning member would still read 41 — which is
    /// exactly what the silent half of #3839 produced — so this assertion, unlike
    /// any shape assertion, cannot be satisfied by a member that lost its
    /// <c>ref</c>.
    /// </summary>
    [Fact]
    public void TranslatedRefMethod_ReturnsAnAliasThatWritesThrough()
    {
        string compiler = FindCompiler();
        Assert.NotNull(compiler);

        string printed = Translate(RefMethodSource);
        string workDir = NewDirectory("runtime");
        string sourcePath = Path.Combine(workDir, "Repro.gs");
        string libraryPath = Path.Combine(workDir, "Repro.dll");
        File.WriteAllText(sourcePath, printed + Environment.NewLine);

        ProcessRunResult compile = ProcessRunner.Run(
            "dotnet",
            new[] { compiler, "/target:library", "/out:" + libraryPath, sourcePath },
            workDir);
        Assert.True(
            compile.ExitCode == 0,
            "gsc must compile the translated ref-returning method. Output:\n" + compile.Output +
                "\nTranslated G#:\n" + printed);

        var loadContext = new AssemblyLoadContext(
            nameof(TranslatedRefMethod_ReturnsAnAliasThatWritesThrough), isCollectible: true);
        try
        {
            Assembly library = loadContext.LoadFromAssemblyPath(libraryPath);
            Type holder = library.GetType("Repro.Holder")
                ?? throw new InvalidOperationException(
                    "Repro.Holder is missing from the emitted assembly: " +
                    string.Join(", ", library.GetTypes().Select(t => t.FullName)));

            // Metadata direction: the emitted method genuinely returns by ref.
            MethodInfo getValue = holder.GetMethod("GetValue")
                ?? throw new InvalidOperationException("GetValue is missing from the emitted type.");
            Assert.True(
                getValue.ReturnType.IsByRef,
                "The emitted GetValue must return by reference, not by value; it returned " +
                    getValue.ReturnType.FullName);

            // Behaviour direction: a C# consumer writes through the reference.
            string driverPath = CompileDriver(workDir, libraryPath);
            Assembly driver = loadContext.LoadFromAssemblyPath(driverPath);
            object result = driver.GetType("Repro.Driver")!.GetMethod("Run")!.Invoke(null, null);

            Assert.Equal(
                99,
                Assert.IsType<int>(result));
        }
        finally
        {
            loadContext.Unload();
        }
    }

    /// <summary>
    /// A C# <c>ref</c> property has no G# form, so it must gap loudly rather than
    /// silently become a copy-returning <c>prop</c>.
    /// </summary>
    [Fact]
    public void RefProperty_StaysLoudGap()
    {
        Assert.Contains(
            Diagnose("""
                namespace Repro
                {
                    public class Holder
                    {
                        private readonly int[] values = new[] { 40, 41, 42 };

                        public ref int Property => ref values[0];
                    }
                }
                """),
            d => d.Severity == TranslationSeverity.Unsupported
                && d.Message.Contains("ref-returning property", StringComparison.Ordinal));
    }

    /// <summary>
    /// <c>ref readonly</c> is the same hazard: the reference is read-only, but it
    /// is still a reference, and a copy-returning property is still a behaviour
    /// change (the caller observes a stale snapshot rather than live storage).
    /// </summary>
    [Fact]
    public void RefReadonlyProperty_StaysLoudGap()
    {
        Assert.Contains(
            Diagnose("""
                namespace Repro
                {
                    public class Holder
                    {
                        private readonly int[] values = new[] { 40, 41, 42 };

                        public ref readonly int Property => ref values[0];
                    }
                }
                """),
            d => d.Severity == TranslationSeverity.Unsupported
                && d.Message.Contains("ref-returning property", StringComparison.Ordinal));
    }

    /// <summary>
    /// The indexer form of the same gap. cs2gs already refuses to translate a
    /// READ through a ref-returning indexer (#1987); the declaration site was the
    /// hole.
    /// </summary>
    [Fact]
    public void RefIndexer_StaysLoudGap()
    {
        Assert.Contains(
            Diagnose("""
                namespace Repro
                {
                    public class Holder
                    {
                        private readonly int[] values = new[] { 40, 41, 42 };

                        public ref int this[int index] => ref values[index];
                    }
                }
                """),
            d => d.Severity == TranslationSeverity.Unsupported
                && d.Message.Contains("ref-returning indexer", StringComparison.Ordinal));
    }

    /// <summary>
    /// Anti-vacuity guard: ordinary properties and indexers must NOT gap. Without
    /// this, "report every property" would satisfy the three tests above.
    /// </summary>
    [Fact]
    public void OrdinaryPropertyAndIndexer_DoNotGap()
    {
        IReadOnlyList<TranslationDiagnostic> diagnostics = Diagnose("""
            namespace Repro
            {
                public class Holder
                {
                    private readonly int[] values = new[] { 40, 41, 42 };

                    public int Property => values[0];

                    public int Count { get; set; }

                    public int this[int index] => values[index];
                }
            }
            """);

        Assert.DoesNotContain(
            diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);
    }

    private static string CompileDriver(string workDir, string libraryPath)
    {
        const string DriverSource = """
            namespace Repro
            {
                public static class Driver
                {
                    public static int Run()
                    {
                        var holder = new Holder();
                        ref int slot = ref holder.GetValue(1);
                        slot = 99;
                        return holder.Read(1);
                    }
                }
            }
            """;

        var references = new List<MetadataReference>(CSharpProjectLoader.RuntimeReferences())
        {
            MetadataReference.CreateFromFile(libraryPath),
        };

        CSharpCompilation compilation = CSharpCompilation.Create(
            "Repro.Driver",
            new[] { CSharpSyntaxTree.ParseText(DriverSource, new CSharpParseOptions(LanguageVersion.Latest)) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        string driverPath = Path.Combine(workDir, "Repro.Driver.dll");
        EmitResult emitted = compilation.Emit(driverPath);
        Assert.True(
            emitted.Success,
            "The C# driver must compile against the gsc-emitted assembly — if `ref int slot = ref " +
                "holder.GetValue(1)` does not compile, the emitted member is not by-ref. Diagnostics:\n" +
                string.Join(Environment.NewLine, emitted.Diagnostics));
        return driverPath;
    }

    private static IReadOnlyList<TranslationDiagnostic> Diagnose(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Repro.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return context.Diagnostics.ToList();
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Repro.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
        return GSharpPrinter.Print(unit);
    }

    private static string NewDirectory(string category)
    {
        string path = Path.Combine(
            AppContext.BaseDirectory,
            "issue-3839-ref-members",
            category,
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }

    private static string FindCompiler()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(
                    dir.FullName, "out", "bin", config, "Compiler", "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            dir = dir.Parent;
        }

        return null;
    }
}
