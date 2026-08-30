// <copyright file="Issue3694AllowNullWriteContractTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Translator-fidelity tests for issue #3694: the WRITE direction of the
/// cross-nullable-context problem whose read direction is #3683/#3687.
///
/// <para>
/// A nullable-<em>oblivious</em> consumer (every <c>test/*</c> project sets
/// <c>&lt;Nullable&gt;disable&lt;/Nullable&gt;</c>) writes <c>null</c> into a
/// property declared non-nullable by an <em>annotated</em> library
/// (<c>src/Core</c>) whose setter deliberately normalises <c>null</c>. C#
/// reports nothing — the write crosses a nullable-context boundary — so no
/// forgiveness or promotion predicate fires, and gsc then rejects the
/// <c>nil</c> at a non-nullable target (GS0155).
/// </para>
///
/// <para>
/// The repair is the declaration-local one: C# spells "the setter accepts
/// <c>null</c>, the getter never returns it" with
/// <see cref="System.Diagnostics.CodeAnalysis.AllowNullAttribute"/>, and G#
/// — which, like Kotlin, has a single nullability per declaration rather than
/// separate input and output contracts — can only honour that by rendering the
/// declaration <c>T?</c>. So an <c>[AllowNull]</c> reference declaration is
/// promoted, in every compilation that sees it, on the strength of the
/// attribute alone. No consumer evidence, and no cross-project taint, is
/// consulted: the answer is a property of the declaration and is therefore the
/// same whichever project is being translated.
/// </para>
/// </summary>
public class Issue3694AllowNullWriteContractTranslationTests
{
    private const string AnnotatedLibrary = @"
using System.Diagnostics.CodeAnalysis;

namespace Library
{
    public class Options
    {
        public int Format { get; set; }
    }

    public class Host
    {
        private Options options = new Options();

        /// <summary>Setting null is normalised to a fresh default instance.</summary>
        [AllowNull]
        public Options Debug
        {
            get => this.options;
            set => this.options = value ?? new Options();
        }
    }
}";

    [Fact]
    public void AnnotatedAllowNullProperty_RendersNullableDeclaration()
    {
        // The library itself is nullable-ENABLED, so nothing in #2113's
        // oblivious taint machinery runs for it. `[AllowNull]` alone decides:
        // the write contract admits nil, and G# has only one contract per
        // declaration, so the declaration is `Options?`.
        (string library, _) = TranslateLibraryAndConsumer(@"
using Library;

namespace App
{
    public static class Use
    {
        public static Host Make() => new Host();
    }
}");

        Assert.Contains("Debug Options?", library);
    }

    [Fact]
    public void ObliviousConsumer_WritesNilIntoAllowNullProperty_NeedsNoBridge()
    {
        // The #3694 site itself: an oblivious test writes `null` into the
        // annotated property through an object initializer. Once the
        // declaration is `Options?` the `nil` binds directly — there is no
        // `!!` that could bridge "assign nil to a non-nil target" anyway, and
        // forcing one would turn a deliberate, supported C# assignment into a
        // runtime throw.
        (_, string consumer) = TranslateLibraryAndConsumer(@"
using Library;

namespace App
{
    public static class Use
    {
        public static Host Make() => new Host { Debug = null };
    }
}");

        Assert.Contains("Host{Debug: nil}", Compact(consumer));
        Assert.DoesNotContain("nil!!", Compact(consumer));
    }

    [Fact]
    public void ObliviousConsumer_ReadsAllowNullProperty_ForgivesTheNullableGetter()
    {
        // Promoting the declaration widens the GETTER too, so every read of it
        // across the corpus has to be forgiven. That cascade is the existing
        // use-site forgiveness pass — the same predicate decides both — and it
        // is sound here because the setter's normalisation means the getter
        // never actually observes nil.
        (_, string consumer) = TranslateLibraryAndConsumer(@"
using Library;

namespace App
{
    public static class Use
    {
        public static int Read(Host host) { return host.Debug.Format; }
    }
}");

        Assert.Contains("host.Debug!!.Format", Compact(consumer));
    }

    [Fact]
    public void AnnotatedPropertyWithoutAllowNull_StaysNonNullable()
    {
        // The negative control that keeps this narrow: an ordinary annotated
        // non-nullable property is untouched. Only the attribute that states
        // the null-accepting write contract promotes.
        const string library = @"
namespace Library
{
    public class Options
    {
        public int Format { get; set; }
    }

    public class Host
    {
        public Options Debug { get; set; } = new Options();
    }
}";
        LoadedCSharpProject projectLibrary = LoadEnabled(library, "Library");
        string printed = TranslateProject(projectLibrary, new[] { projectLibrary.Compilation });

        Assert.Contains("Debug Options", printed);
        Assert.DoesNotContain("Debug Options?", printed);
    }

    [Fact]
    public void AllowNullParameter_RendersNullableParameter()
    {
        // The attribute is legal on parameters too, and means exactly the same
        // thing there: the caller may pass null.
        const string library = @"
using System.Diagnostics.CodeAnalysis;

namespace Library
{
    public class Host
    {
        public string Normalise([AllowNull] string value) => value ?? string.Empty;
    }
}";
        LoadedCSharpProject projectLibrary = LoadEnabled(library, "Library");
        string printed = TranslateProject(projectLibrary, new[] { projectLibrary.Compilation });

        Assert.Contains("Normalise(@AllowNull value string?) string", printed);
    }

    // ---- Helpers -------------------------------------------------------------

    // The two-compilation idiom of Issue2113ObliviousNullableTranslationTests /
    // Issue2412CrossProjectObliviousNullabilityTranslationTests: an ANNOTATED
    // library plus an OBLIVIOUS consumer, translated in one run so both see the
    // same repository compilations.
    private static (string Library, string Consumer) TranslateLibraryAndConsumer(string consumerSource)
    {
        LoadedCSharpProject projectLibrary = LoadEnabled(AnnotatedLibrary, "Library");
        LoadedCSharpProject projectApp = LoadOblivious(
            consumerSource,
            "App",
            new MetadataReference[] { projectLibrary.Compilation.ToMetadataReference() });

        var repository = new[] { projectLibrary.Compilation, projectApp.Compilation };
        return (
            TranslateProject(projectLibrary, repository),
            TranslateProject(projectApp, repository));
    }

    private static LoadedCSharpProject LoadOblivious(
        string source, string assemblyName, IReadOnlyList<MetadataReference> extraReferences = null)
    {
        IReadOnlyList<MetadataReference> references = extraReferences is null
            ? CSharpProjectLoader.RuntimeReferences()
            : CSharpProjectLoader.RuntimeReferences().Concat(extraReferences).ToList();

        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { (assemblyName + ".cs", source) }, references, assemblyName);
        Assert.True(
            project.BoundWithoutErrors,
            $"{assemblyName} should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions);
        return project;
    }

    // `CSharpProjectLoader.LoadInMemory` always builds an oblivious
    // compilation, so a genuinely ANNOTATED library has to be constructed
    // directly with `WithNullableContextOptions(Enable)`.
    private static LoadedCSharpProject LoadEnabled(string source, string assemblyName)
    {
        SyntaxTree tree = CSharpSyntaxTree.ParseText(
            source, new CSharpParseOptions(LanguageVersion.Latest), path: assemblyName + ".cs");
        CSharpCompilation compilation = CSharpCompilation.Create(
            assemblyName,
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));

        var diagnostics = compilation.GetDiagnostics()
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .ToList();
        Assert.True(
            diagnostics.Count == 0,
            $"{assemblyName} should bind with no C# errors: " +
                string.Join(Environment.NewLine, diagnostics));

        var document = new LoadedDocument(assemblyName + ".cs", tree, compilation.GetSemanticModel(tree));
        return new LoadedCSharpProject(compilation, new[] { document }, Array.Empty<Diagnostic>());
    }

    private static string TranslateProject(
        LoadedCSharpProject project, IReadOnlyList<CSharpCompilation> repositoryCompilations)
    {
        var translator = new CSharpToGSharpTranslator();
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath,
            repositoryCompilations,
            repositoryCompilations);
        CompilationUnit unit = translator.TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }

    private static string Compact(string printed) =>
        string.Join(" ", printed.Split(
            new[] { ' ', '\t', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries));
}
