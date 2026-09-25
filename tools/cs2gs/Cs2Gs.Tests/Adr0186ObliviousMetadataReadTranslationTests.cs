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

            public static bool IsNil<T>(T value) where T : class
            {
                return value == null;
            }
        }

        public class Holder
        {
            public Node Child;
        }

        public delegate string Reader();
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
                string kept = "";
                kept = n.Next.Name;
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
    /// Receivers, an assignment and a return that read oblivious
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

    /// <summary>
    /// An implicitly typed local takes its type from its initializer, so its
    /// initializer is an inference position too. Without the <c>!!</c>,
    /// <c>var name = n.Name</c> makes <c>name</c> a <c>string!</c>, and
    /// <c>Wrap(name)</c> then infers <c>List[string!]</c> (GS0155).
    /// </summary>
    [Fact]
    public void An_Implicitly_Typed_Local_Keeps_The_Assertion()
    {
        string libraryPath = this.EmitObliviousLibrary("Adr0186ObliviousLocalInferenceLib");
        string printed = Translate(
            """
            using ObLib;

            public static class Use
            {
                public static int Count(Node n)
                {
                    System.Collections.Generic.List<string> names = new System.Collections.Generic.List<string>();
                    var name = n.Name;
                    names = Wrapping.Wrap(name);
                    return names.Count;
                }
            }
            """,
            MetadataReference.CreateFromFile(libraryPath),
            NullableContextOptions.Disable);

        EmittedOracleResult result = EmittedOracle.Evaluate(
            new[] { printed + Environment.NewLine + "Use.Count(Node.Make(\"a\", nil))" },
            new EmittedOracleOptions { References = new[] { libraryPath } });
        Assert.Contains("let name = n.Name!!", printed, StringComparison.Ordinal);
        Assert.True(result.Diagnostics.IsEmpty, printed + "\n" + string.Join("\n", result.Diagnostics));
        Assert.Equal(1, result.Value);
    }

    /// <summary>
    /// A lambda whose target delegate already returns <c>T?</c> has a fixed,
    /// nullable result type, so its result is not an inference position and
    /// stays bare. With a <c>!!</c> there, a nil name would throw where the
    /// C# returns <c>null</c>. The oracle passes a nil and expects
    /// <c>true</c>.
    /// </summary>
    [Fact]
    public void A_Lambda_With_A_Nullable_Target_Return_Leaves_Its_Result_Bare()
    {
        string libraryPath = this.EmitObliviousLibrary("Adr0186ObliviousLambdaLib");
        string printed = Translate(
            """
            using ObLib;

            public static class Use
            {
                public static bool NameIsNil(Node n)
                {
                    System.Func<string?> read = () => { return n.Name; };
                    return read() == null;
                }
            }
            """,
            MetadataReference.CreateFromFile(libraryPath),
            NullableContextOptions.Disable);

        Assert.DoesNotContain("n.Name!!", printed, StringComparison.Ordinal);

        EmittedOracleResult result = EmittedOracle.Evaluate(
            new[] { printed + Environment.NewLine + "Use.NameIsNil(Node.Make(nil, nil))" },
            new EmittedOracleOptions { References = new[] { libraryPath } });
        Assert.True(result.Diagnostics.IsEmpty, printed + "\n" + string.Join("\n", result.Diagnostics));
        Assert.Equal(true, result.Value);
    }

    /// <summary>
    /// A lambda passed where its delegate type is inferred keeps its result's
    /// <c>!!</c>: <c>Select(x =&gt; x.Name)</c> would otherwise infer
    /// <c>IEnumerable[string!]</c>, and <c>ToList()</c> a <c>List[string!]</c>
    /// that the declared <c>List[string]</c> does not accept (GS0155).
    /// </summary>
    [Fact]
    public void A_Lambda_Whose_Type_Is_Inferred_Keeps_Its_Result_Assertion()
    {
        string libraryPath = this.EmitObliviousLibrary("Adr0186ObliviousSelectLib");
        string printed = Translate(
            """
            using System.Linq;
            using ObLib;

            public static class Use
            {
                public static int Count(Node n)
                {
                    System.Collections.Generic.List<string> names = new[] { n }.Select(x => x.Name).ToList();
                    return names.Count;
                }
            }
            """,
            MetadataReference.CreateFromFile(libraryPath),
            NullableContextOptions.Disable);

        Assert.Contains("x.Name!!", printed, StringComparison.Ordinal);

        EmittedOracleResult result = EmittedOracle.Evaluate(
            new[] { printed + Environment.NewLine + "Use.Count(Node.Make(\"a\", nil))" },
            new EmittedOracleOptions { References = new[] { libraryPath } });
        Assert.True(result.Diagnostics.IsEmpty, printed + "\n" + string.Join("\n", result.Diagnostics));
        Assert.Equal(1, result.Value);
    }

    /// <summary>
    /// A lambda converted to an oblivious delegate (<c>Reader</c>, whose Invoke
    /// returns <c>string!</c>) has a fixed result type too, so its result stays
    /// bare, and a nil name is returned rather than thrown.
    /// </summary>
    [Fact]
    public void A_Lambda_With_An_Oblivious_Target_Return_Leaves_Its_Result_Bare()
    {
        string libraryPath = this.EmitObliviousLibrary("Adr0186ObliviousDelegateLib");
        string printed = Translate(
            """
            using ObLib;

            public static class Use
            {
                public static bool NameIsNil(Node n)
                {
                    Reader read = () => n.Name;
                    return read() == null;
                }
            }
            """,
            MetadataReference.CreateFromFile(libraryPath),
            NullableContextOptions.Disable);

        Assert.DoesNotContain("n.Name!!", printed, StringComparison.Ordinal);

        EmittedOracleResult result = EmittedOracle.Evaluate(
            new[] { printed + Environment.NewLine + "Use.NameIsNil(Node.Make(nil, nil))" },
            new EmittedOracleOptions { References = new[] { libraryPath } });
        Assert.True(result.Diagnostics.IsEmpty, printed + "\n" + string.Join("\n", result.Diagnostics));
        Assert.Equal(true, result.Value);
    }

    /// <summary>
    /// Explicit type arguments leave nothing to infer, so the inference
    /// carve-out does not apply: <c>IsNil&lt;string&gt;(n.Name)</c> stays bare.
    /// With the old <c>!!</c>, a nil name threw instead of reaching the
    /// callee, which C# never did. The oracle passes a nil and expects
    /// <c>true</c>.
    /// </summary>
    [Fact]
    public void Explicit_Type_Arguments_Do_Not_Keep_The_Assertion()
    {
        string libraryPath = this.EmitObliviousLibrary("Adr0186ObliviousExplicitLib");
        string printed = Translate(
            """
            using ObLib;

            public static class Use
            {
                public static bool NameIsNil(Node n)
                {
                    return Wrapping.IsNil<string>(n.Name);
                }
            }
            """,
            MetadataReference.CreateFromFile(libraryPath),
            NullableContextOptions.Disable);

        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal);

        EmittedOracleResult result = EmittedOracle.Evaluate(
            new[] { printed + Environment.NewLine + "Use.NameIsNil(Node.Make(nil, nil))" },
            new EmittedOracleOptions { References = new[] { libraryPath } });
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    /// <summary>
    /// An unqualified inherited member used as an assignment-target receiver
    /// (<c>Child.Name = value</c>, where <c>Child</c> comes from an oblivious
    /// base class) is the same platform-typed read, so it stays bare too.
    /// </summary>
    [Fact]
    public void An_Inherited_Oblivious_Member_As_An_Assignment_Receiver_Is_Left_Bare()
    {
        string libraryPath = this.EmitObliviousLibrary("Adr0186ObliviousInheritedLib");
        string printed = Translate(
            """
            using ObLib;

            public class Derived : Holder
            {
                public void Rename(string value)
                {
                    Child.Name = value;
                }
            }
            """,
            MetadataReference.CreateFromFile(libraryPath),
            NullableContextOptions.Disable);

        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal);
        Assert.Contains("this.Child.Name = value", printed, StringComparison.Ordinal);

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        TranslationTestValidation.AssertBinds(resolver, printed);
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
