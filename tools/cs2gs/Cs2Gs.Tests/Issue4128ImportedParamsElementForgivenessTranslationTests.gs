// <copyright file="Issue4128ImportedParamsElementForgivenessTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// Translator-fidelity tests for issue #4128: a promoted-nullable value flowing
/// into the expanded ELEMENT slot of an IMPORTED `params T[]` parameter
/// must still be bridged with `!!`.
///
/// Issue #3888 taught the declaration side to widen a params element to
/// `...T?` when that position receives direct or transitive null evidence,
/// and taught `TargetWillRemainNonNullableReference` to skip the bridge
/// wherever that widening applies. The sink-contract half was never gated on
/// whether this migration run actually EMITS the declaration, and
/// `ObliviousNullabilityAnalyzer.IsParamsElementTainted` keys its evidence
/// on the owning method's documentation-comment ID — which an imported method
/// has just as much as a source one. So a call site passing a promoted
/// `Type?` taints the element position of
/// `System.Type.MakeGenericType(params Type[])`, and the resulting
/// "already widened" prediction suppresses the bridge that same argument needs.
/// The prediction is circular for a frozen target: gsc imports the BCL carrier
/// as `...Type` from its nullable metadata and nothing cs2gs decides can
/// widen it.
///
/// That was the single diagnostic blocking migrated `test/Core.Tests` — the
/// last app in the 56-project corpus failing to COMPILE (issue #3501):
/// `ReferenceResolverTests.gs(244,47): error GS0155: Cannot convert type
/// 'System.Type?' to 'System.Type'` at
/// `openTask.MakeGenericType(element)`.
///
/// Probed scope (recorded here because the issue asked, and because a narrower
/// reading would invite a keyed-to-one-call fix): the defect is specific to the
/// params ELEMENT slot. An ordinary imported non-null reference parameter —
/// `Activator.CreateInstance(Type)`, `int.Parse(string)`,
/// `List<Type>.Add(T)` — already bridged correctly, because those
/// targets take the `targetDeclaredInThisCompilation` tail of
/// `TargetWillRemainNonNullableReference`, which has carried the same-run
/// gate since issue #2521. A SOURCE-declared params carrier also behaved, for a
/// different reason: cs2gs emits its declaration, so the #3888 widening it
/// predicts is real. Only the imported params element combined both an
/// unwidenable contract and an ungated prediction.
open class Issue4128ImportedParamsElementForgivenessTranslationTests {
    /// The migrated test/Core.Tests `ReferenceResolverTests` wall: a local
    /// promoted to `Type?` (initialized from the annotated-BCL
    /// `Type.GetElementType()`) expanded into
    /// `Type.MakeGenericType(params Type[])` must assert `!!` against
    /// the imported non-null element contract.
    @Fact
    func ImportedParamsElement_PromotedLocal_AssertsNonNull() {
        let printed = TranslateOblivious(`
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
}`)
        Assert.Contains("let element Type? =", printed)
        Assert.Contains("openTask.MakeGenericType(element!!)", printed)
    }

    /// The same repair with more than one value in the expanded tail: every
    /// element position binds the one imported element contract, so the
    /// promoted value is bridged and its non-null sibling is left alone.
    @Fact
    func ImportedParamsElement_MultipleExpandedArguments_AssertsOnlyTheNullableOne() {
        let printed = TranslateOblivious(`
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
}`)
        Assert.Contains("openPair.MakeGenericType(element!!, typeof(int32))", printed)
    }

    /// Precision guard for issue #3888, which this repair must not undo: a
    /// SOURCE-declared params carrier IS emitted by this run, so its element
    /// really does widen to `...T?` under the same null evidence and the
    /// argument needs no bridge. Asserting here would be a regression in the
    /// other direction — `!!` is a runtime throw in G#, not C#'s erased
    /// `!`, so a gratuitous assertion turns a legal call into a crash.
    @Fact
    func SourceDeclaredParamsElement_WidenedDeclaration_StaysBare() {
        let printed = TranslateOblivious(`
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
}`)
        Assert.Contains("func Collect(elements ...Type?)", printed)
        Assert.Contains("Collect(element)", printed)
        Assert.DoesNotContain("Collect(element!!)", printed)
    }

    /// Precision guard: a value that was never promoted grows no assertion in
    /// an imported expanded params tail.
    @Fact
    func ImportedParamsElement_NonNullableValue_StaysBare() {
        let printed = TranslateOblivious(`
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
}`)
        Assert.Contains("openTask.MakeGenericType(element)", printed)
        Assert.DoesNotContain("element!!", printed)
    }

    /// Precision guard: the CARRIER position (a whole array passed in normal
    /// form) is unaffected — it never took the element exception, and a
    /// non-null array argument still needs no bridge.
    @Fact
    func ImportedParamsCarrier_NormalFormArray_StaysBare() {
        let printed = TranslateOblivious(`
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
}`)
        Assert.Contains("openTask.MakeGenericType(elements)", printed)
        Assert.DoesNotContain("elements!!", printed)
    }

    /// Regression guard for the #4146 Copilot review of this issue's fix:
    /// `TargetContractIsFrozenInMetadata` must compare assembly
    /// IDENTITY, not the bare simple-name string. Two DIFFERENT assemblies
    /// can legitimately share a simple name — here, a genuine same-run
    /// sibling project ("Shared" v1.0.0.0, unrelated to the params sink) and
    /// an EXTERNAL, frozen "Shared" v2.0.0.0 that actually declares
    /// `Sink.Collect(params Type[])`. A name-only comparison matches the
    /// sibling by coincidence and misclassifies the external sink's contract
    /// as "emitted this run", silently dropping the `!!` bridge its
    /// imported, unwidenable `params Type[]` element still needs — a
    /// variant of #4128 itself. Reverting the identity comparison back to
    /// `AssemblyName` string equality makes this test fail.
    @Fact
    func ImportedParamsElement_SameSimpleNameDifferentIdentitySibling_StillAssertsNonNull() {
        const sharedV1Source = `
using System.Reflection;

[assembly: AssemblyVersion("1.0.0.0")]

namespace SharedLib
{
    public static class Unrelated
    {
        public static void Noop()
        {
        }
    }
}`
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
        const sharedV2Source = `
using System;
using System.Reflection;

[assembly: AssemblyVersion("2.0.0.0")]

namespace SharedLib
{
    public static class Sink
    {
        public static void Collect(params Type[] elements)
        {
        }
    }
}`
        let sharedV1 = LoadNamed(sharedV1Source, "Shared")
        let sharedV2Compilation = CreateEnabledCompilation(sharedV2Source, "Shared")
        // Prove the fixture actually exercises a same-name/different-identity
        // collision before trusting what the translator does with it.
        Assert.Equal(sharedV1.Compilation.AssemblyName, sharedV2Compilation.AssemblyName)
        Assert.NotEqual(sharedV1.Compilation.Assembly.Identity, sharedV2Compilation.Assembly.Identity)
        const appSource = `
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
}`
        let app = LoadNamed(appSource, "App", []MetadataReference{EmitToMetadataReference(sharedV2Compilation)})
        let document = Assert.Single(app.Documents)
        let context = TranslationContext(
            app.Compilation,
            document.SemanticModel,
            document.FilePath,
            siblingCompilations: nil,
            repositoryCompilations: []CSharpCompilation{app.Compilation, sharedV1.Compilation}
        )
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        // Round-trip only (not `AssertBinds`, which the other tests in this
        // file use): the printed snippet imports `SharedLib`, a package this
        // single-file fixture never emits — the same multi-assembly
        // limitation `Issue2412CrossProjectObliviousNullabilityTranslationTests`
        // documents on `ValidateRoundTripOnly`. Only the parse/print
        // round-trip and the `!!` bridge below are this test's concern.
        let roundTrip = TranslationTestValidation.ValidateRoundTripOnly(
            printed,
            "Binder.BindGlobalScope cannot resolve the external SharedLib import in this single-file fixture."
        )
        Assert.True(roundTrip.Success, string.Join(Environment.NewLine, roundTrip.Errors))
        Assert.Contains("Sink.Collect(element!!)", printed)
    }

    shared {
        private func LoadNamed(
            source string,
            assemblyName string,
            extraReferences IReadOnlyList[MetadataReference]? = nil
        ) LoadedCSharpProject {
            let references = if extraReferences == nil {
                CSharpProjectLoader.RuntimeReferences()
            } else {
                cast[IReadOnlyList[MetadataReference]](
                    CSharpProjectLoader.RuntimeReferences().Concat(extraReferences).ToList()
                )
            }
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, source string){(assemblyName + ".cs", source)},
                references,
                assemblyName
            )
            Assert.True(
                project.BoundWithoutErrors,
                "$assemblyName should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            return project
        }

        // Builds a NULLABLE-ENABLED in-memory compilation directly (bypassing
        // `CSharpProjectLoader.LoadInMemory`, which always defaults to
        // `NullableContextOptions.Disable`) so its emitted metadata carries real
        // nullable-annotation bytes, matching a genuinely annotated external
        // dependency (e.g. the real BCL).
        private func CreateEnabledCompilation(source string, assemblyName string) CSharpCompilation {
            let tree = CSharpSyntaxTree.ParseText(
                source,
                CSharpParseOptions(LanguageVersion.Latest),
                path: assemblyName + ".cs"
            )
            let compilation = CSharpCompilation.Create(
                assemblyName,
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            let diagnostics = compilation
                .GetDiagnostics()
                .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
                .ToList()
            Assert.True(
                diagnostics.Count == 0,
                "$assemblyName should bind with no C# errors: " + string.Join(Environment.NewLine, diagnostics)
            )
            return compilation
        }

        // Emits a compilation to real PE bytes and wraps it as a metadata
        // reference — unlike `Compilation.ToMetadataReference()`, this produces a
        // genuinely syntax-less imported symbol on the referencing side (see the
        // comment on `ImportedParamsElement_SameSimpleNameDifferentIdentitySibling_StillAssertsNonNull`).
        private func EmitToMetadataReference(compilation CSharpCompilation) MetadataReference {
            using let stream = MemoryStream()
            let emit = compilation.Emit(stream)
            Assert.True(
                emit.Success,
                "${compilation.AssemblyName} must emit: " + string.Join(Environment.NewLine, emit.Diagnostics)
            )
            return MetadataReference.CreateFromImage(stream.ToArray())
        }

        private func TranslateOblivious(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            return PrintAndValidate(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        private func PrintAndValidate(unit CompilationUnit) string {
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }
    }
}
