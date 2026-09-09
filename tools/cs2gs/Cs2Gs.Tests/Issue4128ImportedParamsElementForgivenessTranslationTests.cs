// <copyright file="Issue4128ImportedParamsElementForgivenessTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Translator-fidelity tests for issue #4128: a promoted-nullable value flowing
/// into the expanded ELEMENT slot of an IMPORTED <c>params T[]</c> parameter
/// must still be bridged with <c>!!</c>.
/// <para>
/// Issue #3888 taught the declaration side to widen a params element to
/// <c>...T?</c> when that position receives direct or transitive null evidence,
/// and taught <c>TargetWillRemainNonNullableReference</c> to skip the bridge
/// wherever that widening applies. The sink-contract half was never gated on
/// whether this migration run actually EMITS the declaration, and
/// <c>ObliviousNullabilityAnalyzer.IsParamsElementTainted</c> keys its evidence
/// on the owning method's documentation-comment ID — which an imported method
/// has just as much as a source one. So a call site passing a promoted
/// <c>Type?</c> taints the element position of
/// <c>System.Type.MakeGenericType(params Type[])</c>, and the resulting
/// "already widened" prediction suppresses the bridge that same argument needs.
/// The prediction is circular for a frozen target: gsc imports the BCL carrier
/// as <c>...Type</c> from its nullable metadata and nothing cs2gs decides can
/// widen it.
/// </para>
/// <para>
/// That was the single diagnostic blocking migrated <c>test/Core.Tests</c> — the
/// last app in the 56-project corpus failing to COMPILE (issue #3501):
/// <c>ReferenceResolverTests.gs(244,47): error GS0155: Cannot convert type
/// 'System.Type?' to 'System.Type'</c> at
/// <c>openTask.MakeGenericType(element)</c>.
/// </para>
/// <para>
/// Probed scope (recorded here because the issue asked, and because a narrower
/// reading would invite a keyed-to-one-call fix): the defect is specific to the
/// params ELEMENT slot. An ordinary imported non-null reference parameter —
/// <c>Activator.CreateInstance(Type)</c>, <c>int.Parse(string)</c>,
/// <c>List&lt;Type&gt;.Add(T)</c> — already bridged correctly, because those
/// targets take the <c>targetDeclaredInThisCompilation</c> tail of
/// <c>TargetWillRemainNonNullableReference</c>, which has carried the same-run
/// gate since issue #2521. A SOURCE-declared params carrier also behaved, for a
/// different reason: cs2gs emits its declaration, so the #3888 widening it
/// predicts is real. Only the imported params element combined both an
/// unwidenable contract and an ungated prediction.
/// </para>
/// </summary>
public class Issue4128ImportedParamsElementForgivenessTranslationTests
{
    /// <summary>
    /// The migrated test/Core.Tests <c>ReferenceResolverTests</c> wall: a local
    /// promoted to <c>Type?</c> (initialized from the annotated-BCL
    /// <c>Type.GetElementType()</c>) expanded into
    /// <c>Type.MakeGenericType(params Type[])</c> must assert <c>!!</c> against
    /// the imported non-null element contract.
    /// </summary>
    [Fact]
    public void ImportedParamsElement_PromotedLocal_AssertsNonNull()
    {
        string printed = TranslateOblivious(@"
using System;

namespace Demo
{
    public static class Projection
    {
        public static Type Close(Type projected, Type openTask)
        {
            var element = projected.GetElementType();
            return openTask.MakeGenericType(element);
        }
    }
}");

        Assert.Contains("let element Type? =", printed);
        Assert.Contains("openTask.MakeGenericType(element!!)", printed);
    }

    /// <summary>
    /// The same repair with more than one value in the expanded tail: every
    /// element position binds the one imported element contract, so the
    /// promoted value is bridged and its non-null sibling is left alone.
    /// </summary>
    [Fact]
    public void ImportedParamsElement_MultipleExpandedArguments_AssertsOnlyTheNullableOne()
    {
        string printed = TranslateOblivious(@"
using System;

namespace Demo
{
    public static class Projection
    {
        public static Type Close(Type projected, Type openPair)
        {
            var element = projected.GetElementType();
            return openPair.MakeGenericType(element, typeof(int));
        }
    }
}");

        Assert.Contains("openPair.MakeGenericType(element!!, typeof(int32))", printed);
    }

    /// <summary>
    /// Precision guard for issue #3888, which this repair must not undo: a
    /// SOURCE-declared params carrier IS emitted by this run, so its element
    /// really does widen to <c>...T?</c> under the same null evidence and the
    /// argument needs no bridge. Asserting here would be a regression in the
    /// other direction — <c>!!</c> is a runtime throw in G#, not C#'s erased
    /// <c>!</c>, so a gratuitous assertion turns a legal call into a crash.
    /// </summary>
    [Fact]
    public void SourceDeclaredParamsElement_WidenedDeclaration_StaysBare()
    {
        string printed = TranslateOblivious(@"
using System;

namespace Demo
{
    public static class Projection
    {
        public static void Close(Type projected)
        {
            var element = projected.GetElementType();
            Collect(element);
        }

        private static void Collect(params Type[] elements)
        {
        }
    }
}");

        Assert.Contains("func Collect(elements ...Type?)", printed);
        Assert.Contains("Collect(element)", printed);
        Assert.DoesNotContain("Collect(element!!)", printed);
    }

    /// <summary>
    /// Precision guard: a value that was never promoted grows no assertion in
    /// an imported expanded params tail.
    /// </summary>
    [Fact]
    public void ImportedParamsElement_NonNullableValue_StaysBare()
    {
        string printed = TranslateOblivious(@"
using System;

namespace Demo
{
    public static class Projection
    {
        public static Type Close(Type element, Type openTask)
        {
            return openTask.MakeGenericType(element);
        }
    }
}");

        Assert.Contains("openTask.MakeGenericType(element)", printed);
        Assert.DoesNotContain("element!!", printed);
    }

    /// <summary>
    /// Precision guard: the CARRIER position (a whole array passed in normal
    /// form) is unaffected — it never took the element exception, and a
    /// non-null array argument still needs no bridge.
    /// </summary>
    [Fact]
    public void ImportedParamsCarrier_NormalFormArray_StaysBare()
    {
        string printed = TranslateOblivious(@"
using System;

namespace Demo
{
    public static class Projection
    {
        public static Type Close(Type[] elements, Type openTask)
        {
            return openTask.MakeGenericType(elements);
        }
    }
}");

        Assert.Contains("openTask.MakeGenericType(elements)", printed);
        Assert.DoesNotContain("elements!!", printed);
    }

    /// <summary>
    /// Regression guard for the #4146 Copilot review of this issue's fix:
    /// <c>TargetContractIsFrozenInMetadata</c> must compare assembly
    /// IDENTITY, not the bare simple-name string. Two DIFFERENT assemblies
    /// can legitimately share a simple name — here, a genuine same-run
    /// sibling project ("Shared" v1.0.0.0, unrelated to the params sink) and
    /// an EXTERNAL, frozen "Shared" v2.0.0.0 that actually declares
    /// <c>Sink.Collect(params Type[])</c>. A name-only comparison matches the
    /// sibling by coincidence and misclassifies the external sink's contract
    /// as "emitted this run", silently dropping the <c>!!</c> bridge its
    /// imported, unwidenable <c>params Type[]</c> element still needs — a
    /// variant of #4128 itself. Reverting the identity comparison back to
    /// <c>AssemblyName</c> string equality makes this test fail.
    /// </summary>
    [Fact]
    public void ImportedParamsElement_SameSimpleNameDifferentIdentitySibling_StillAssertsNonNull()
    {
        const string sharedV1Source = @"
using System.Reflection;

[assembly: AssemblyVersion(""1.0.0.0"")]

namespace SharedLib
{
    public static class Unrelated
    {
        public static void Noop()
        {
        }
    }
}";
        // `#nullable enable` AND a genuinely EMITTED reference (below, via
        // `EmitToMetadataReference`, not `.ToMetadataReference()`): the frozen
        // contract this test defends only arises for a target with (a) real
        // nullable-annotation metadata (`IsImportedObliviousNullableTarget`
        // returns early for a genuinely oblivious import, before the
        // params-element/frozen logic this test exercises is ever reached)
        // and (b) NO `DeclaringSyntaxReferences` — a `CompilationReference`
        // (`.ToMetadataReference()`) shares the referenced compilation's
        // actual source symbols in-process, so `TargetContractIsFrozenInMetadata`'s
        // own syntax-reference guard would trivially short-circuit before
        // ever reaching the identity comparison this test targets. Emitting
        // to real PE bytes first, as the BCL genuinely is, is required to
        // reproduce a truly syntax-less imported symbol.
        const string sharedV2Source = @"
using System;
using System.Reflection;

[assembly: AssemblyVersion(""2.0.0.0"")]

namespace SharedLib
{
    public static class Sink
    {
        public static void Collect(params Type[] elements)
        {
        }
    }
}";
        LoadedCSharpProject sharedV1 = LoadNamed(sharedV1Source, "Shared");
        CSharpCompilation sharedV2Compilation = CreateEnabledCompilation(sharedV2Source, "Shared");

        // Prove the fixture actually exercises a same-name/different-identity
        // collision before trusting what the translator does with it.
        Assert.Equal(sharedV1.Compilation.AssemblyName, sharedV2Compilation.AssemblyName);
        Assert.NotEqual(sharedV1.Compilation.Assembly.Identity, sharedV2Compilation.Assembly.Identity);

        const string appSource = @"
using System;
using SharedLib;

namespace Demo
{
    public static class Projection
    {
        public static void Close(Type projected)
        {
            var element = projected.GetElementType();
            Sink.Collect(element);
        }
    }
}";
        LoadedCSharpProject app = LoadNamed(
            appSource,
            "App",
            new MetadataReference[] { EmitToMetadataReference(sharedV2Compilation) });

        LoadedDocument document = Assert.Single(app.Documents);
        var context = new TranslationContext(
            app.Compilation,
            document.SemanticModel,
            document.FilePath,
            siblingCompilations: null,
            repositoryCompilations: new[] { app.Compilation, sharedV1.Compilation });
        string printed = GSharpPrinter.Print(
            new CSharpToGSharpTranslator().TranslateDocument(document, context));

        // Round-trip only (not `AssertBinds`, which the other tests in this
        // file use): the printed snippet imports `SharedLib`, a package this
        // single-file fixture never emits — the same multi-assembly
        // limitation `Issue2412CrossProjectObliviousNullabilityTranslationTests`
        // documents on `ValidateRoundTripOnly`. Only the parse/print
        // round-trip and the `!!` bridge below are this test's concern.
        RoundTripResult roundTrip = TranslationTestValidation.ValidateRoundTripOnly(
            printed,
            "Binder.BindGlobalScope cannot resolve the external SharedLib import in this single-file fixture.");
        Assert.True(roundTrip.Success, string.Join(Environment.NewLine, roundTrip.Errors));

        Assert.Contains("Sink.Collect(element!!)", printed);
    }

    private static LoadedCSharpProject LoadNamed(
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
        return project;
    }

    // Builds a NULLABLE-ENABLED in-memory compilation directly (bypassing
    // `CSharpProjectLoader.LoadInMemory`, which always defaults to
    // `NullableContextOptions.Disable`) so its emitted metadata carries real
    // nullable-annotation bytes, matching a genuinely annotated external
    // dependency (e.g. the real BCL).
    private static CSharpCompilation CreateEnabledCompilation(string source, string assemblyName)
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
            .Where(d => d.Severity == DiagnosticSeverity.Error).ToList();
        Assert.True(
            diagnostics.Count == 0,
            $"{assemblyName} should bind with no C# errors: " + string.Join(Environment.NewLine, diagnostics));
        return compilation;
    }

    // Emits a compilation to real PE bytes and wraps it as a metadata
    // reference — unlike `Compilation.ToMetadataReference()`, this produces a
    // genuinely syntax-less imported symbol on the referencing side (see the
    // comment on `ImportedParamsElement_SameSimpleNameDifferentIdentitySibling_StillAssertsNonNull`).
    private static MetadataReference EmitToMetadataReference(CSharpCompilation compilation)
    {
        using var stream = new System.IO.MemoryStream();
        Microsoft.CodeAnalysis.Emit.EmitResult emit = compilation.Emit(stream);
        Assert.True(
            emit.Success,
            $"{compilation.AssemblyName} must emit: " + string.Join(Environment.NewLine, emit.Diagnostics));
        return MetadataReference.CreateFromImage(stream.ToArray());
    }

    private static string TranslateOblivious(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        return PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    private static string PrintAndValidate(CompilationUnit unit)
    {
        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
