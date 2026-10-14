// <copyright file="Issue2412CrossProjectObliviousNullabilityTranslationTests.cs" company="GSharp">
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
import System.Linq
import Xunit

/// Regression tests for issue #2412: (cref:ObliviousNullabilityAnalyzer)'s
/// whole-program taint fixpoint (issues #2113/#2157/#2167/#2259/#2285) is
/// scoped to ONE (cref:CSharpCompilation), but
/// `CSharpProjectLoader.LoadProjectWithReferencesAsync` (used by every
/// app with a `ProjectReference`) loads the app and each transitively
/// referenced sibling project as SEPARATE compilations linked only by ordinary
/// project/metadata references. A downstream project's translator asking
/// whether a symbol DECLARED IN a referenced sibling is null-tainted used to
/// walk only its own (downstream) compilation's syntax trees — which never
/// contain the sibling's tainting evidence — and always answer "no", so the
/// `!!` forgiveness (cref:CSharpToGSharpTranslator) already emits
/// correctly for the intra-project case (issue #914) never fired across a
/// project boundary. This is the exact shape of the real-world Oahu.Core
/// `AaxExporter.ExportChapters` diagnostic (GS0156 on `book.Asin`,
/// a member declared in Oahu.Data and correctly promoted there, consumed
/// bare in Oahu.Core).
///
/// <b>Fix</b>: `TranslateStage` now threads every loaded project's own
/// (cref:CSharpCompilation) (the app plus its transitive
/// `ProjectReference` closure) into every (cref:TranslationContext)
/// it creates ((cref:TranslationContext.SiblingCompilations)).
/// (cref:CSharpToGSharpTranslator)'s single promotion choke point
/// (`ShouldPromoteToNullableReference`) now calls a new three-argument
/// (cref:ObliviousNullabilityAnalyzer.IsTainted(CSharpCompilation, ISymbol,
/// IReadOnlyList{CSharpCompilation}))
/// overload that tries the current compilation first (byte-identical to the
/// existing two-argument overload — every single-compilation caller passes no
/// sibling set) and then, only if that reports untainted, each sibling's OWN
/// cached taint result in turn — a symbol tainted in ANY ONE known project's
/// own analysis is a single global fact, since interface-implementation edges
/// (issue #2285) can record taint for a symbol declared in a THIRD project
/// entirely (the real Oahu shape: the tainting `?.` evidence and the
/// interface edge both live in Oahu.Data, but the promoted symbol,
/// `IBookMeta.Asin`, is declared in Oahu.Foundation).
///
/// Object-initializer assignment sinks already routed through
/// `ShouldPromoteToNullableReference` via `ForgiveObjectInitializerValue`
/// / `IsNullablePromotedValue`, so the three-argument overload alone
/// covers them. RETURN and ARGUMENT positions route instead through
/// `ReceiverNeedsNullForgiveness`, whose general (declared-nullable,
/// flow-narrowed) branch gates on Roslyn's `NullableFlowState.NotNull` —
/// never reported in an oblivious compilation — so that method needed one
/// additional, narrowly-scoped branch: when a value read resolves to a
/// field/property/method DECLARED IN A DIFFERENT ASSEMBLY than the current
/// compilation's own AND that sibling's own analysis proves it tainted,
/// assert `!!` directly, bypassing the flow-state gate. This is disjoint
/// from every existing intra-project branch (all of which require the SAME
/// assembly), so no existing single-compilation behavior changes.
open class Issue2412CrossProjectObliviousNullabilityTranslationTests {
    @Fact
    func CrossProject_ObjectInitializerAssignment_FromReferencedInterfaceMember_InsertsForgiveness() {
        const LibASource = `
using LibB;

namespace LibA
{
    public class Target
    {
        public string Name { get; set; }
    }

    public class Consumer
    {
        public Target Make(IFoo foo) => new Target { Name = foo.Name };
    }
}`
        let (printedB, printedA) = TranslateTwoProjects(LibBSource, LibASource)
        // LibB's own translation is unaffected: `IFoo.Name`/`Impl.Name` are
        // still promoted to `string?` purely from LibB's own `Other?.Name`
        // evidence (issue #914/#2285), independent of any sibling.
        // LibA's `Target.Name` is Target's OWN declared property, assigned
        // (not read) from the tainted `foo.Name` — it must stay non-nullable
        // `string` (issue #2412's own worked example: the fix must not
        // repaint an unrelated declaration's own type). Only the read of the
        // cross-project-tainted `foo.Name` at the consumption site gets `!!`
        // forgiveness.
        Assert.Contains("prop Name string", Compact(printedA))
        Assert.DoesNotContain("prop Name string?", Compact(printedA))
        Assert.Contains("Target{Name: foo.Name!!}", Compact(printedA))
    }

    @Fact
    func CrossProject_ReturnPosition_FromReferencedInterfaceMember_InsertsForgiveness() {
        const LibASource = `
using LibB;

namespace LibA
{
    public class Consumer
    {
        public string GetName(IFoo foo)
        {
            return foo.Name;
        }
    }
}`
        let (_, printedA) = TranslateTwoProjects(LibBSource, LibASource)
        Assert.Contains("return foo.Name!!", Compact(printedA))
    }

    @Fact
    func CrossProject_MethodArgumentPosition_FromReferencedInterfaceMember_InsertsForgiveness() {
        const LibASource = `
using LibB;

namespace LibA
{
    public class Sink
    {
        public void Accept(string s) { }
    }

    public class Consumer
    {
        public void Run(IFoo foo, Sink sink)
        {
            sink.Accept(foo.Name);
        }
    }
}`
        let (_, printedA) = TranslateTwoProjects(LibBSource, LibASource)
        Assert.Contains("sink.Accept(foo.Name!!)", Compact(printedA))
    }

    @Fact
    func CrossProject_MethodArgumentPosition_FromUnpromotedReferencedProperty_DoesNotSwitchToForeignSyntaxTree() {
        const libB = `
namespace LibB
{
    public class Widget
    {
        public string Name => "fixed";
    }
}`
        const libA = `
using LibB;

namespace LibA
{
    public class Sink
    {
        public void Accept(string value) { }
    }

    public class Consumer
    {
        public void Run(Widget widget, Sink sink)
        {
            sink.Accept(widget.Name);
        }
    }
}`
        let (_, printedA) = TranslateTwoProjects(libB, libA)
        // Referenced oblivious members use the existing conservative external
        // member assertion policy. The regression is reaching that policy
        // without asking LibA's compilation for LibB's foreign syntax tree.
        Assert.Contains("sink.Accept(widget.Name!!)", Compact(printedA))
    }

    @Fact
    func CrossProject_ArgumentToPromotedSiblingParameter_DoesNotInsertRuntimeAssertion() {
        const libB = `
namespace LibB
{
    public class Service
    {
        public void Accept(string value)
        {
            _ = value?.Length;
        }
    }
}`
        const libA = `
using LibB;

namespace LibA
{
    public class Settings
    {
        public string Value { get; set; }
    }

    public class Consumer
    {
        public void Run(Service service, Settings settings)
        {
            service.Accept(settings?.Value);
        }
    }
}`
        let (printedB, printedA) = TranslateTwoProjects(libB, libA)
        Assert.Contains("func Accept(value string?)", Compact(printedB))
        Assert.Contains("service.Accept(settings?.Value)", Compact(printedA))
        Assert.DoesNotContain("service.Accept((settings?.Value)!!)", Compact(printedA))
    }

    @Fact
    func CrossProject_NonGenericDelegateParameter_PromotedBySibling_DoesNotAssert() {
        const libB = `
namespace LibB
{
    public delegate void Callback();

    public class Service
    {
        public void Accept(Callback callback)
        {
            if (callback is not null) { }
        }
    }
}`
        const libA = `
using LibB;

namespace LibA
{
    public class Consumer
    {
        public void Run(Service service, Callback callback = null)
        {
            service.Accept(callback);
        }
    }
}`
        let (printedB, printedA) = TranslateTwoProjects(libB, libA)
        Assert.Contains("func Accept(callback Callback?)", Compact(printedB))
        Assert.Contains("service.Accept(callback)", Compact(printedA))
        Assert.DoesNotContain("service.Accept(callback!!)", Compact(printedA))
    }

    @Fact
    func CrossProject_GenericDelegateParameter_PromotedBySibling_DoesNotAssert() {
        const libB = `
namespace LibB
{
    public delegate void Callback<T>(T value);

    public class Service<T>
    {
        public void Accept(Callback<T> callback)
        {
            if (callback is not null) { }
        }
    }
}`
        const libA = `
using LibB;

namespace LibA
{
    public class Consumer
    {
        public void Run(Service<string> service, Callback<string> callback = null)
        {
            service.Accept(callback);
        }
    }
}`
        let (printedB, printedA) = TranslateTwoProjects(libB, libA)
        Assert.Contains("func Accept(callback Callback[T]?)", Compact(printedB))
        Assert.Contains("service.Accept(callback)", Compact(printedA))
        Assert.DoesNotContain("service.Accept(callback!!)", Compact(printedA))
    }

    @Fact
    func CrossProject_FieldTarget_FromReferencedInterfaceMember_InsertsForgiveness() {
        const LibASource = `
using LibB;

namespace LibA
{
    public class Holder
    {
        public string Name;
    }

    public class Consumer
    {
        public Holder Make(IFoo foo) => new Holder { Name = foo.Name };
    }
}`
        let (_, printedA) = TranslateTwoProjects(LibBSource, LibASource)
        Assert.Contains("Holder{Name: foo.Name!!}", Compact(printedA))
    }

    // ---- Negative controls --------------------------------------------------
    @Fact
    func CrossProject_UnrelatedUntaintedSiblingMember_IsForgivenAtImportedBoundary() {
        // `Plain.Label` has no taint evidence, but its imported oblivious
        // reference contract is still T? to gsc and needs a target-aware bridge.
        const libB = `
namespace LibB
{
    public interface IFoo
    {
        string Name { get; }
    }

    public class Impl : IFoo
    {
        public Impl Other { get; set; }
        public string Name => Other?.Name;
    }

    public class Plain
    {
        public string Label => "fixed";
    }
}`
        const libA = `
using LibB;

namespace LibA
{
    public class Target
    {
        public string Name { get; set; }
    }

    public class Consumer
    {
        public Target Make(Plain plain) => new Target { Name = plain.Label };
    }
}`
        let (printedB, printedA) = TranslateTwoProjects(libB, libA)
        Assert.Contains("prop Label string -> \"fixed\"", printedB)
        Assert.DoesNotContain("prop Label string? ", printedB)
        Assert.Contains("Target{Name: plain.Label!!}", Compact(printedA))
    }

    @Fact
    func CrossProject_NullableEnabledSiblingProject_Unaffected() {
        // A nullable-ENABLED sibling's OWN declared annotation drives promotion
        // (independent of ObliviousNullabilityAnalyzer, which never runs for an
        // enabled compilation) — the cross-project wiring must not perturb that
        // existing, already-correct path: a non-null `string` member stays a
        // bare, non-`!!` read downstream, and a genuinely nullable `string?`
        // member (real annotation, not taint) is read with the SAME forgiveness
        // an intra-project nullable-enabled reference would already get.
        const libB = `
#nullable enable
namespace LibB
{
    public class Enabled
    {
        public string NonNull => "x";

        public string? Nullable => null;
    }
}`
        const libA = `
using LibB;

namespace LibA
{
    public class Target
    {
        public string A { get; set; }
        public string B { get; set; }
    }

    public class Consumer
    {
        public Target Make(Enabled e) => new Target { A = e.NonNull, B = e.Nullable! };
    }
}`
        let (printedB, printedA) = TranslateTwoProjects(libB, libA, obliviousB: false)
        // `NonNull` is a plain, genuinely non-nullable `string` — no `!!`.
        // `Nullable` is a genuinely `string?`-annotated property (not
        // taint-promoted) — the ALREADY-correct nullable-enabled path
        // (independent of this fix) inserts `!!` from its own declared
        // annotation, and the cross-project wiring must not disturb that.
        Assert.Contains("Target{A: e.NonNull, B: e.Nullable!!}", Compact(printedA))
    }

    @Fact
    func CrossProject_SameSimpleMemberNameInTwoSiblings_UsesImportedContracts() {
        // Both siblings emit non-null source contracts, while the consumer sees
        // their independently imported oblivious reference contracts as T?.
        const libC = `
namespace LibC
{
    public interface IFoo
    {
        string Name { get; }
    }

    public class Impl : IFoo
    {
        public string Name => "fixed-c";
    }
}`
        let projectB = LoadOblivious(LibBSource, "LibB")
        let projectC = LoadOblivious(libC, "LibC")
        const libA = `
using B = LibB;
using C = LibC;

namespace LibA
{
    public class TargetB
    {
        public string Name { get; set; }
    }

    public class TargetC
    {
        public string Name { get; set; }
    }

    public class Consumer
    {
        public TargetB MakeB(B.IFoo foo) => new TargetB { Name = foo.Name };

        public TargetC MakeC(C.IFoo foo) => new TargetC { Name = foo.Name };
    }
}`
        let projectA = LoadOblivious(
            libA,
            "LibA",
            []MetadataReference{projectB.Compilation.ToMetadataReference(), projectC.Compilation.ToMetadataReference()}
        )
        let siblings = []CSharpCompilation{projectA.Compilation, projectB.Compilation, projectC.Compilation}
        let printedB = TranslateProject(projectB, siblings)
        let printedC = TranslateProject(projectC, siblings)
        let printedA = TranslateProject(projectA, siblings)
        for printed in[]string{printedA, printedB, printedC} {
            let roundTrip = TranslationTestValidation.ValidateRoundTripOnly(
                printed,
                "Binder.BindGlobalScope cannot resolve alias-qualified types across this multi-package fixture."
            )
            Assert.True(roundTrip.Success, string.Join(Environment.NewLine, roundTrip.Errors))
        }
        Assert.Contains("prop Name string {", printedC)
        Assert.DoesNotContain("prop Name string? {", printedC)
        Assert.Contains("TargetB{Name: foo.Name!!}", Compact(printedA))
        Assert.Contains("TargetC{Name: foo.Name!!}", Compact(printedA))
    }

    @Fact
    func CrossProject_ReverseDependentPropertyTaint_ForgivesInferredLocalReceiver() {
        const data = `
namespace Data
{
    public class Response
    {
        public string[] Items { get; set; }
    }

    public static class Reader
    {
        public static int Count(Response response)
        {
            var items = response.Items;
            return items.Length;
        }
    }
}`
        let projectData = LoadOblivious(data, "Data")
        const core = `
using Data;

namespace Core
{
    public static class Reset
    {
        public static void Clear(Response response) { response.Items = null; }
    }
}`
        let projectCore = LoadOblivious(
            core,
            "Core",
            []MetadataReference{projectData.Compilation.ToMetadataReference()}
        )
        let siblings = []CSharpCompilation{projectData.Compilation, projectCore.Compilation}
        let document = Assert.Single(projectData.Documents)
        let context = TranslationContext(
            projectData.Compilation,
            document.SemanticModel,
            document.FilePath,
            siblingCompilations: nil,
            repositoryCompilations: siblings
        )
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains("prop Items []?string", printed)
        Assert.Contains("return items!!.Length", printed)
    }

    @Fact
    func CrossProject_ReverseDependentRecordParameterTaint_WidensStoredContract() {
        const data = `
namespace Data
{
    public record Context(string Progress);
}`
        let projectData = LoadOblivious(data, "Data")
        const app = `
using Data;

namespace App
{
    public static class Factory
    {
        public static Context Create() => new Context(null);
    }
}`
        let projectApp = LoadOblivious(app, "App", []MetadataReference{projectData.Compilation.ToMetadataReference()})
        let repository = []CSharpCompilation{projectData.Compilation, projectApp.Compilation}
        let document = Assert.Single(projectData.Documents)
        let context = TranslationContext(
            projectData.Compilation,
            document.SemanticModel,
            document.FilePath,
            siblingCompilations: nil,
            repositoryCompilations: repository
        )
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains("data class Context(Progress string?)", printed)
    }

    @Fact
    func CrossProject_MigratedSiblingObjectInitializer_UsesCompositeLiteral() {
        const library = `
namespace Library
{
    public class Widget
    {
        public bool Enabled { get; set; }
    }
}`
        let projectLibrary = LoadOblivious(library, "Library")
        const app = `
using Library;

namespace App
{
    public static class Factory
    {
        public static Widget Create() => new Widget { Enabled = true };
    }
}`
        let projectApp = LoadOblivious(
            app,
            "App",
            []MetadataReference{projectLibrary.Compilation.ToMetadataReference()}
        )
        let document = Assert.Single(projectApp.Documents)
        let context = TranslationContext(
            projectApp.Compilation,
            document.SemanticModel,
            document.FilePath,
            siblingCompilations: nil,
            repositoryCompilations: []CSharpCompilation{projectLibrary.Compilation, projectApp.Compilation}
        )
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains("Widget{Enabled: true}", Compact(printed))
    }

    // ---- Transitive (three-project) chain: the real Oahu shape -------------
    @Fact
    func CrossProject_TransitiveThreeProjects_InterfaceMemberDeclaredInThirdProject_InsertsForgiveness() {
        // Mirrors Oahu exactly: `IBookMeta.Asin` (LibFoundation) is get-only and
        // carries NO evidence of its own; `Conversion.Asin` (LibData) is the
        // ONLY `?.`-seeded evidence, and LibData's OWN interface-implementation
        // edges (issue #2285) are what promote `IBookMeta.Asin` — a symbol
        // declared in a THIRD project — inside LibData's own taint fixpoint.
        // LibCore (the consumer) references LibData directly and LibFoundation
        // transitively; it must still insert `!!` for `book.Asin`.
        const libFoundation = `
namespace LibFoundation
{
    public interface IBookMeta
    {
        string Asin { get; }
    }
}`
        const libData = `
using LibFoundation;

namespace LibData
{
    public interface IBookCommon : IBookMeta
    {
    }

    public class BookMetaHolder
    {
        public IBookMeta BookMeta { get; set; }
    }

    public class Conversion : IBookCommon
    {
        public BookMetaHolder Holder { get; set; }

        public string Asin => Holder?.BookMeta?.Asin;
    }
}`
        let projectFoundation = LoadOblivious(libFoundation, "LibFoundation")
        let projectData = LoadOblivious(
            libData,
            "LibData",
            []MetadataReference{projectFoundation.Compilation.ToMetadataReference()}
        )
        const libCore = `
using LibData;
using LibFoundation;

namespace LibCore
{
    public class ContentReference
    {
        public string Asin { get; set; }
    }

    public class AaxExporter
    {
        public ContentReference Export(IBookCommon book) => new ContentReference { Asin = book.Asin };
    }
}`
        let projectCore = LoadOblivious(
            libCore,
            "LibCore",
            []MetadataReference{
                projectData.Compilation.ToMetadataReference(),
                projectFoundation.Compilation.ToMetadataReference()
            }
        )
        let siblings = []CSharpCompilation{
            projectCore.Compilation,
            projectData.Compilation,
            projectFoundation.Compilation
        }
        let printedFoundation = TranslateProject(projectFoundation, siblings)
        let printedData = TranslateProject(projectData, siblings)
        let printedCore = TranslateProject(projectCore, siblings)
        TranslationTestValidation.AssertBinds(printedCore, printedData, printedFoundation)
        // LibData's own standalone translation already promotes both endpoints
        // (issue #2285) — the interface member declared in Foundation AND its
        // own implementing property.
        Assert.Contains("prop Asin string? ->", printedData)
        // The regression: LibCore inserts the forgiveness for the Foundation-
        // declared interface member, whose only evidence lives in LibData.
        Assert.Contains("ContentReference{Asin: book.Asin!!}", Compact(printedCore))
    }

    // ---- Determinism / caching ----------------------------------------------
    @Fact
    func CrossProject_RepeatedTranslation_IsDeterministicAndConsistent() {
        const LibASource = `
using LibB;

namespace LibA
{
    public class Target
    {
        public string Name { get; set; }
    }

    public class Consumer
    {
        public Target Make(IFoo foo) => new Target { Name = foo.Name };
    }
}`
        let projectB = LoadOblivious(LibBSource, "LibB")
        let projectA = LoadOblivious(
            LibASource,
            "LibA",
            []MetadataReference{projectB.Compilation.ToMetadataReference()}
        )
        let siblings = []CSharpCompilation{projectA.Compilation, projectB.Compilation}
        // Two INDEPENDENT translator instances (as every real pipeline stage
        // creates one per project) over the SAME loaded projects must agree —
        // the fix must not depend on incidental ordering of which project gets
        // translated (and therefore cached) first.
        let firstPrintedA = TranslateProject(projectA, siblings)
        let firstPrintedB = TranslateProject(projectB, siblings)
        let secondPrintedB = TranslateProject(projectB, siblings)
        let secondPrintedA = TranslateProject(projectA, siblings)
        TranslationTestValidation.AssertBinds(firstPrintedA, firstPrintedB)
        TranslationTestValidation.AssertBinds(secondPrintedA, secondPrintedB)
        Assert.Equal(firstPrintedA, secondPrintedA)
        Assert.Equal(firstPrintedB, secondPrintedB)
        Assert.Contains("Target{Name: foo.Name!!}", Compact(firstPrintedA))
        Assert.Contains("Target{Name: foo.Name!!}", Compact(secondPrintedA))
    }

    shared {
        // ---- Issue's own minimal LibA/LibB repro -------------------------------
        private const LibBSource string = `
namespace LibB
{
    public interface IFoo
    {
        string Name { get; }
    }

    public class Impl : IFoo
    {
        public Impl Other { get; set; }
        public string Name => Other?.Name;
    }
}`

        // ---- Helpers -------------------------------------------------------------
        private func TranslateTwoProjects(sourceB string, sourceA string, obliviousB bool = true)(
            PrintedB string,
            PrintedA string
        ) {
            let projectB = if obliviousB {
                LoadOblivious(sourceB, "LibB")
            } else {
                LoadEnabled(sourceB, "LibB")
            }
            let projectA = LoadOblivious(
                sourceA,
                "LibA",
                []MetadataReference{projectB.Compilation.ToMetadataReference()}
            )
            let siblings = []CSharpCompilation{projectA.Compilation, projectB.Compilation}
            let printedB = TranslateProject(projectB, siblings)
            let printedA = TranslateProject(projectA, siblings)
            TranslationTestValidation.AssertBinds(printedA, printedB)
            return (printedB, printedA)
        }

        private func LoadOblivious(
            source string,
            assemblyName string,
            extraReferences IReadOnlyList[MetadataReference]? = nil
        ) LoadedCSharpProject {
            let project = LoadWithReferences(source, assemblyName, extraReferences)
            Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
            return project
        }

        private func LoadEnabled(
            source string,
            assemblyName string,
            extraReferences IReadOnlyList[MetadataReference]? = nil
        ) LoadedCSharpProject {
            // `CSharpProjectLoader.LoadInMemory` always builds a compilation with
            // DEFAULT `CSharpCompilationOptions` (`NullableContextOptions.Disable`)
            // — a `#nullable enable` PRAGMA inside the source only changes each
            // file's own per-tree annotation context, never the compilation-level
            // option `ObliviousNullabilityAnalyzer.IsTainted` gates on to decide
            // whether a compilation participates in taint analysis at all. A
            // genuinely nullable-ENABLED sibling compilation (for the negative
            // control proving the cross-project wiring does not perturb the
            // already-correct nullable-annotation-driven path) must instead be
            // built directly with `WithNullableContextOptions(Enable)`.
            let references = if extraReferences == nil {
                CSharpProjectLoader.RuntimeReferences()
            } else {
                cast[IReadOnlyList[MetadataReference]](
                    CSharpProjectLoader.RuntimeReferences().Concat(extraReferences).ToList()
                )
            }
            let tree = CSharpSyntaxTree.ParseText(
                source,
                CSharpParseOptions(LanguageVersion.Latest),
                path: assemblyName + ".cs"
            )
            let compilation = CSharpCompilation.Create(
                assemblyName,
                []SyntaxTree{tree},
                references,
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
            let document = LoadedDocument(assemblyName + ".cs", tree, compilation.GetSemanticModel(tree))
            let project = LoadedCSharpProject(compilation, []LoadedDocument{document}, Array.Empty[Diagnostic]())
            Assert.NotEqual(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
            return project
        }

        private func LoadWithReferences(
            source string,
            assemblyName string,
            extraReferences IReadOnlyList[MetadataReference]?
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

        private func TranslateProject(
            project LoadedCSharpProject,
            siblingCompilations IReadOnlyList[CSharpCompilation]
        ) string {
            let translator = CSharpToGSharpTranslator()
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(
                project.Compilation,
                document.SemanticModel,
                document.FilePath,
                siblingCompilations,
                repositoryCompilations: siblingCompilations
            )
            let unit = translator.TranslateDocument(document, context)
            return GSharpPrinter.Print(unit)
        }

        // Collapses incidental whitespace/newlines around composite-literal braces
        // so an assertion on `Target{Name: foo.Name!!}` is not sensitive to the
        // printer's exact line-wrapping.
        private func Compact(printed string) string -> string.Join(
            " ",
            printed.Split([]char{' ', '\t', '\r', '\n'}, StringSplitOptions.RemoveEmptyEntries)
        )
    }
}
