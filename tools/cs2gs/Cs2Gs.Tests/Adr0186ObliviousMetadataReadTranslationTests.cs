// <copyright file="Adr0186ObliviousMetadataReadTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// ADR-0186 step 6 (PR 0): a read of oblivious CLR metadata that no project in
/// the migration run emits is the platform type <c>T!</c> in gsc (since step
/// 3), and gsc inserts the nil check itself wherever such a value is coerced
/// to a non-null reference, receivers included. cs2gs therefore leaves those
/// reads bare instead of emitting <c>!!</c>.
/// <para>
/// These tests compile the translation against a real oblivious assembly, so
/// they witness what the string assertions elsewhere cannot: that the bare
/// output binds, that a nil still throws <see cref="NullReferenceException"/>
/// at the same point, and that the two carve-outs (a member this run also
/// migrates, and a value whose platform-ness would reach type inference) keep
/// their <c>!!</c>.
/// </para>
/// </summary>
public sealed class Adr0186ObliviousMetadataReadTranslationTests : IDisposable
{
    private const string LibrarySource = """
        namespace ObLib;

        public class Node
        {
            public string Name;
            public Node Next;
            public static Node Make(string name, Node next)
            {
                var node = new Node();
                node.Name = name;
                node.Next = next;
                return node;
            }
            public string Describe() { return "node"; }
        }

        public static class Wrapping
        {
            public static System.Collections.Generic.List<T> Wrap<T>(T value)
            {
                return new System.Collections.Generic.List<T> { value };
            }
        }
        """;

    private const string ConsumerSource = """
        using ObLib;

        public static class Use
        {
            public static int NextNameLength(Node n)
            {
                return n.Next.Name.Length;
            }

            public static string Describe(Node n)
            {
                return n.Next.Describe();
            }

            public static string Keep(Node n)
            {
                string kept = n.Next.Name;
                return kept;
            }

            public static int Probe(Node n)
            {
                try
                {
                    return NextNameLength(n);
                }
                catch (System.NullReferenceException)
                {
                    return -1;
                }
            }
        }
        """;

    private readonly string directory = Path.Combine(
        Path.GetTempPath(),
        "cs2gs-adr0186-oblivious-read-" + Guid.NewGuid().ToString("N"));

    /// <inheritdoc/>
    public void Dispose()
    {
        try
        {
            Directory.Delete(this.directory, recursive: true);
        }
        catch (IOException)
        {
            // Best effort: a loaded assembly can keep the file open on some hosts.
        }
        catch (UnauthorizedAccessException)
        {
            // Best effort, as above.
        }
    }

    /// <summary>
    /// Receivers, an explicitly typed local and a return that read oblivious
    /// metadata carry no <c>!!</c>, and the output binds against that metadata.
    /// Restoring the pre-step-3 <c>T?</c> mirror rule puts the <c>!!</c> back
    /// and fails the first assertion.
    /// </summary>
    [Fact]
    public void Oblivious_Metadata_Reads_Are_Left_Bare_And_Bind()
    {
        string libraryPath = this.EmitObliviousLibrary("Adr0186ObliviousReadLib");
        string printed = Translate(
            ConsumerSource,
            MetadataReference.CreateFromFile(libraryPath),
            NullableContextOptions.Disable);

        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal);
        Assert.Contains("n.Next.Name.Length", printed, StringComparison.Ordinal);
        Assert.Contains("n.Next.Describe()", printed, StringComparison.Ordinal);

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        TranslationTestValidation.AssertBinds(resolver, printed);
    }

    /// <summary>
    /// The runtime half: with no <c>!!</c> in the output, a nil read through
    /// oblivious metadata still throws <see cref="NullReferenceException"/>,
    /// because gsc checks the <c>T!</c> receiver itself. That is the same
    /// exception, at the same dereference, that C# and the old <c>!!</c> gave.
    /// </summary>
    [Fact]
    public void A_Nil_Oblivious_Read_Still_Throws_NullReferenceException()
    {
        string libraryPath = this.EmitObliviousLibrary("Adr0186ObliviousRuntimeLib");
        string printed = Translate(
            ConsumerSource,
            MetadataReference.CreateFromFile(libraryPath),
            NullableContextOptions.Disable);
        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal);

        EmittedOracleResult present = EmittedOracle.Evaluate(
            new[] { printed + Environment.NewLine + "Use.Probe(Node.Make(\"a\", Node.Make(\"abc\", nil)))" },
            new EmittedOracleOptions { References = new[] { libraryPath } });
        Assert.Empty(present.Diagnostics);
        Assert.Equal(3, present.Value);

        EmittedOracleResult missing = EmittedOracle.Evaluate(
            new[] { printed + Environment.NewLine + "Use.Probe(Node.Make(\"a\", nil))" },
            new EmittedOracleOptions { References = new[] { libraryPath } });
        Assert.Empty(missing.Diagnostics);
        Assert.Equal(-1, missing.Value);
    }

    /// <summary>
    /// A member declared in a project this run also migrates is not frozen
    /// metadata: cs2gs decides its emitted type, which is <c>T</c> or a
    /// promoted <c>T?</c>, never <c>T!</c>. Its reads keep the existing rule.
    /// Dropping the frozen-metadata gate removes these <c>!!</c>.
    /// </summary>
    [Fact]
    public void A_Member_This_Run_Migrates_Keeps_Its_Assertion()
    {
        CSharpCompilation library = CompileLibrary("Adr0186ObliviousSiblingLib");
        string printed = Translate(
            ConsumerSource,
            library.ToMetadataReference(),
            NullableContextOptions.Disable);

        Assert.Contains("n.Next!!", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// A value whose platform-ness would reach type inference keeps its
    /// <c>!!</c>: <c>Wrap(n.Name)</c> would otherwise infer
    /// <c>List[string!]</c>, which ADR-0186 §3 rule 3 does not convert to the
    /// <c>List[string]</c> the local declares (GS0155). The compile check
    /// fails if the assertion is dropped.
    /// </summary>
    [Fact]
    public void A_Value_That_Feeds_Inference_Keeps_Its_Assertion()
    {
        string libraryPath = this.EmitObliviousLibrary("Adr0186ObliviousInferenceLib");
        string printed = Translate(
            """
            using ObLib;

            public static class Use
            {
                public static int Count(Node n)
                {
                    System.Collections.Generic.List<string> names = new System.Collections.Generic.List<string>();
                    names = Wrapping.Wrap(n.Name);
                    return names.Count;
                }
            }
            """,
            MetadataReference.CreateFromFile(libraryPath),
            NullableContextOptions.Disable);

        Assert.Contains("Wrap(n.Name!!)", printed, StringComparison.Ordinal);

        // Compiled through gsc's `/r:` channel, which resolves the generic
        // `List<T>` return (the metadata-only binder resolver does not).
        EmittedOracleResult result = EmittedOracle.Evaluate(
            new[] { printed + Environment.NewLine + "Use.Count(Node.Make(\"a\", nil))" },
            new EmittedOracleOptions { References = new[] { libraryPath } });
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    private static string Translate(
        string source,
        MetadataReference library,
        NullableContextOptions nullable)
    {
        SyntaxTree tree = CSharpSyntaxTree.ParseText(
            source,
            new CSharpParseOptions(LanguageVersion.Latest),
            path: "Snippet.cs");
        var compilation = CSharpCompilation.Create(
            "Adr0186ObliviousReadConsumer",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences().Append(library).ToImmutableArray(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(nullable));
        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            diagnostic => diagnostic.Severity == DiagnosticSeverity.Error);

        SemanticModel model = compilation.GetSemanticModel(tree);
        var document = new LoadedDocument("Snippet.cs", tree, model);
        var context = new TranslationContext(compilation, model, document.FilePath);
        return GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    private static CSharpCompilation CompileLibrary(string assemblyName) =>
        CSharpCompilation.Create(
            assemblyName,
            new[] { CSharpSyntaxTree.ParseText(LibrarySource, new CSharpParseOptions(LanguageVersion.Latest)) },
            CSharpProjectLoader.RuntimeReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Disable));

    private string EmitObliviousLibrary(string assemblyName)
    {
        Directory.CreateDirectory(this.directory);
        string path = Path.Combine(this.directory, assemblyName + ".dll");
        Microsoft.CodeAnalysis.Emit.EmitResult emit = CompileLibrary(assemblyName).Emit(path);
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));
        return path;
    }
}
