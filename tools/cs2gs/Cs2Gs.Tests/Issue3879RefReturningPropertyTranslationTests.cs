// <copyright file="Issue3879RefReturningPropertyTranslationTests.cs" company="GSharp">
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
/// Issue #3879 (ADR-0060 amendment): G# gained a by-ref return on <c>prop</c>, so
/// the property/indexer half of #3839 — which PR #3878 correctly gapped, because
/// there was no G# spelling to translate into — now translates.
/// <list type="bullet">
/// <item>A C# <c>ref</c> property becomes <c>prop P ref T -&gt; lvalue</c> (or the
/// block form when the body does not fold).</item>
/// <item>A C# <c>ref</c> indexer becomes <c>prop this[…] ref T -&gt; lvalue</c>.</item>
/// <item><c>ref readonly</c> still gaps loudly. G# has no read-only by-ref return,
/// and rendering one as a plain <c>ref</c> would hand the caller a WRITABLE alias
/// to storage the C# author declared read-only — the same class of silent
/// behaviour change the copy-returning form was.</item>
/// </list>
/// <para>
/// The aliasing is proven by EXECUTION, reusing #3878's shape: a printed-shape
/// assertion passes just as happily on a copy-returning member. gsc compiles the
/// translated G# into a library, a C# driver is compiled against it with Roslyn,
/// and the driver takes <c>ref int slot = ref holder.Property</c>, writes through
/// it, and reads the storage back through a separate accessor. (The driver is C#
/// rather than G# because G#'s ref-alias binder does not accept a call result as
/// an lvalue — the documented #1900 limit.)
/// </para>
/// </summary>
public sealed class Issue3879RefReturningPropertyTranslationTests
{
    private const string RefMemberSource = """
        namespace Repro
        {
            public class Holder
            {
                private readonly int[] values = new[] { 40, 41, 42 };

                public ref int Property => ref values[0];

                public ref int this[int index] => ref values[index];

                public int Read(int index) => values[index];
            }
        }
        """;

    /// <summary>
    /// The declaration keeps its <c>ref</c>, on the property and on the indexer.
    /// The G# arrow form is ref-aware (gsc desugars <c>prop P ref T -&gt; e</c> to
    /// <c>{ get { return ref e } }</c>), so the idiomatic ADR-0131 fold survives
    /// — unlike the <c>func</c> arrow, which #3839 had to refuse.
    /// </summary>
    [Fact]
    public void RefPropertyAndIndexer_KeepTheirRefOnTheDeclaration()
    {
        string printed = Translate(RefMemberSource);

        Assert.Contains("prop Property ref int32 -> values[0]", printed, StringComparison.Ordinal);
        Assert.Contains("prop this[index int32] ref int32 -> values[index]", printed, StringComparison.Ordinal);

        // The defect shape #3839 named: the member migrating into a
        // copy-returning `prop Property int32`.
        Assert.DoesNotContain("prop Property int32", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("prop this[index int32] int32", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// Anti-vacuity guard: ordinary properties and indexers must NOT acquire a
    /// <c>ref</c>. Without this, "always print `ref`" would satisfy the test
    /// above.
    /// </summary>
    [Fact]
    public void OrdinaryPropertyAndIndexer_StayByValue()
    {
        string printed = Translate("""
            namespace Repro
            {
                public class Plain
                {
                    private readonly int[] values = new[] { 1, 2, 3 };

                    public int Property => values[0];

                    public int Count { get; set; }

                    public int this[int index] => values[index];
                }
            }
            """);

        Assert.Contains("prop Property int32 -> values[0]", printed, StringComparison.Ordinal);
        Assert.Contains("prop this[index int32] int32 -> values[index]", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("ref int32", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// The executing proof. gsc compiles the translated G#; a C# driver takes a
    /// reference through the emitted property and through the emitted indexer,
    /// writes through both, and reads the storage back. A copy-returning member
    /// would still read 40/41 — which is exactly what the silent half of #3839
    /// produced — so this assertion, unlike any shape assertion, cannot be
    /// satisfied by a member that lost its <c>ref</c>.
    /// </summary>
    [Fact]
    public void TranslatedRefPropertyAndIndexer_ReturnAliasesThatWriteThrough()
    {
        string compiler = FindCompiler();
        Assert.NotNull(compiler);

        string printed = Translate(RefMemberSource);
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
            "gsc must compile the translated ref-returning property and indexer. Output:\n" + compile.Output +
                "\nTranslated G#:\n" + printed);

        var loadContext = new AssemblyLoadContext(
            nameof(TranslatedRefPropertyAndIndexer_ReturnAliasesThatWriteThrough), isCollectible: true);
        try
        {
            Assembly library = loadContext.LoadFromAssemblyPath(libraryPath);
            Type holder = library.GetType("Repro.Holder")
                ?? throw new InvalidOperationException(
                    "Repro.Holder is missing from the emitted assembly: " +
                    string.Join(", ", library.GetTypes().Select(t => t.FullName)));

            // Metadata direction: the emitted members genuinely return by ref,
            // on the PropertyDef row AND on the getter MethodDef.
            foreach (string name in new[] { "Property", "Item" })
            {
                PropertyInfo property = holder.GetProperty(name)
                    ?? throw new InvalidOperationException($"'{name}' is missing from the emitted type.");
                Assert.True(
                    property.PropertyType.IsByRef,
                    $"the emitted '{name}' must be by-ref; it was {property.PropertyType}");
                Assert.True(
                    property.GetMethod!.ReturnType.IsByRef,
                    $"the emitted get_{name} must return by reference; it returned {property.GetMethod.ReturnType}");
            }

            // Behaviour direction: a C# consumer writes through the references.
            string driverPath = CompileDriver(workDir, libraryPath);
            Assembly driver = loadContext.LoadFromAssemblyPath(driverPath);
            object result = driver.GetType("Repro.Driver")!.GetMethod("Run")!.Invoke(null, null)!;

            Assert.Equal(new[] { 99, 88 }, Assert.IsType<int[]>(result));
        }
        finally
        {
            loadContext.Unload();
        }
    }

    /// <summary>
    /// <c>ref readonly</c> keeps the loud gap. The reference is read-only, and G#
    /// has no read-only by-ref return, so the only available renderings are a
    /// copy (drops the aliasing) or a plain <c>ref</c> (silently makes read-only
    /// storage writable). Neither is a faithful translation.
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
                && d.Message.Contains("ref readonly", StringComparison.Ordinal));
    }

    /// <summary>The indexer form of the same <c>ref readonly</c> gap.</summary>
    [Fact]
    public void RefReadonlyIndexer_StaysLoudGap()
    {
        Assert.Contains(
            Diagnose("""
                namespace Repro
                {
                    public class Holder
                    {
                        private readonly int[] values = new[] { 40, 41, 42 };

                        public ref readonly int this[int index] => ref values[index];
                    }
                }
                """),
            d => d.Severity == TranslationSeverity.Unsupported
                && d.Message.Contains("ref readonly", StringComparison.Ordinal));
    }

    /// <summary>
    /// Issue #1987's USE-site gap is lifted for a plain <c>ref</c> indexer: the
    /// declaration now translates, and gsc's emitter loads through the returned
    /// managed pointer at the read, so a plain index expression is the correct
    /// lowering with the same read semantics C# gives it.
    /// </summary>
    [Fact]
    public void ReadThroughARefIndexer_NoLongerGaps()
    {
        IReadOnlyList<TranslationDiagnostic> diagnostics = Diagnose("""
            namespace Repro
            {
                public class Holder
                {
                    private readonly int[] values = new[] { 40, 41, 42 };

                    public ref int this[int index] => ref values[index];

                    public int Sum() => this[0] + this[1];
                }
            }
            """);

        Assert.DoesNotContain(diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
    }

    /// <summary>
    /// The concrete migration consequence #3879 was filed to unblock:
    /// <c>test/Interpreter.Tests/Issue3004ManagedByRefAutoDereferenceFixture.cs</c>
    /// was the whole app's only translate-stage blocker in the self-migration
    /// gate (#3501), with exactly two CS2GS-GAP fingerprints — its <c>ref</c>
    /// property and its <c>ref</c> indexer. Reproduced verbatim so a regression
    /// here is recognisable as that failure and not as a generic one.
    /// </summary>
    [Fact]
    public void TheInterpreterTestsByRefFixture_TranslatesWithoutGaps()
    {
        string printed = Translate("""
            namespace GSharp.Interpreter.Tests.Issue3004;

            /// <summary>
            /// CLR ref-return shapes used to guard managed-byref auto-dereference.
            /// </summary>
            public sealed class ManagedByRefAutoDereferenceFixture
            {
                private readonly int[] values = [40, 41, 42];

                /// <summary>Gets the first value by reference.</summary>
                public ref int Property => ref values[0];

                /// <summary>Gets a value by reference through an indexer.</summary>
                /// <param name="index">The value index.</param>
                public ref int this[int index] => ref values[index];

                /// <summary>Gets a value by reference through an instance call.</summary>
                /// <param name="index">The value index.</param>
                /// <returns>A reference to the selected value.</returns>
                public ref int GetValue(int index) => ref values[index];
            }
            """);

        // Translate() already asserts no Unsupported diagnostics; these pin the
        // three shapes so a future "translates, but drops the ref" cannot pass.
        Assert.Contains("prop Property ref int32 -> values[0]", printed, StringComparison.Ordinal);
        Assert.Contains("prop this[index int32] ref int32 -> values[index]", printed, StringComparison.Ordinal);
        Assert.Contains("return ref values[index]", printed, StringComparison.Ordinal);
    }

    private static string CompileDriver(string workDir, string libraryPath)
    {
        const string DriverSource = """
            namespace Repro
            {
                public static class Driver
                {
                    public static int[] Run()
                    {
                        var holder = new Holder();

                        ref int fromProperty = ref holder.Property;
                        fromProperty = 99;

                        ref int fromIndexer = ref holder[1];
                        fromIndexer = 88;

                        return new[] { holder.Read(0), holder.Read(1) };
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
                "holder.Property` does not compile, the emitted member is not by-ref. Diagnostics:\n" +
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
            "issue-3879-ref-properties",
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
