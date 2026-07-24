// <copyright file="Issue2412CrossProjectObliviousNullabilityTranslationTests.cs" company="GSharp">
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
/// Regression tests for issue #2412: <see cref="ObliviousNullabilityAnalyzer"/>'s
/// whole-program taint fixpoint (issues #2113/#2157/#2167/#2259/#2285) is
/// scoped to ONE <see cref="CSharpCompilation"/>, but
/// <c>CSharpProjectLoader.LoadProjectWithReferencesAsync</c> (used by every
/// app with a <c>ProjectReference</c>) loads the app and each transitively
/// referenced sibling project as SEPARATE compilations linked only by ordinary
/// project/metadata references. A downstream project's translator asking
/// whether a symbol DECLARED IN a referenced sibling is null-tainted used to
/// walk only its own (downstream) compilation's syntax trees — which never
/// contain the sibling's tainting evidence — and always answer "no", so the
/// `!!` forgiveness <see cref="CSharpToGSharpTranslator"/> already emits
/// correctly for the intra-project case (issue #914) never fired across a
/// project boundary. This is the exact shape of the real-world Oahu.Core
/// <c>AaxExporter.ExportChapters</c> diagnostic (GS0156 on <c>book.Asin</c>,
/// a member declared in Oahu.Data and correctly promoted there, consumed
/// bare in Oahu.Core).
/// <para>
/// <b>Fix</b>: <c>TranslateStage</c> now threads every loaded project's own
/// <see cref="CSharpCompilation"/> (the app plus its transitive
/// <c>ProjectReference</c> closure) into every <see cref="TranslationContext"/>
/// it creates (<see cref="TranslationContext.SiblingCompilations"/>).
/// <see cref="CSharpToGSharpTranslator"/>'s single promotion choke point
/// (<c>ShouldPromoteToNullableReference</c>) now calls a new three-argument
/// <see cref="ObliviousNullabilityAnalyzer.IsTainted(CSharpCompilation, ISymbol, IReadOnlyList{CSharpCompilation})"/>
/// overload that tries the current compilation first (byte-identical to the
/// existing two-argument overload — every single-compilation caller passes no
/// sibling set) and then, only if that reports untainted, each sibling's OWN
/// cached taint result in turn — a symbol tainted in ANY ONE known project's
/// own analysis is a single global fact, since interface-implementation edges
/// (issue #2285) can record taint for a symbol declared in a THIRD project
/// entirely (the real Oahu shape: the tainting <c>?.</c> evidence and the
/// interface edge both live in Oahu.Data, but the promoted symbol,
/// <c>IBookMeta.Asin</c>, is declared in Oahu.Foundation).
/// </para>
/// <para>
/// Object-initializer assignment sinks already routed through
/// <c>ShouldPromoteToNullableReference</c> via <c>ForgiveObjectInitializerValue</c>
/// / <c>IsNullablePromotedValue</c>, so the three-argument overload alone
/// covers them. RETURN and ARGUMENT positions route instead through
/// <c>ReceiverNeedsNullForgiveness</c>, whose general (declared-nullable,
/// flow-narrowed) branch gates on Roslyn's <c>NullableFlowState.NotNull</c> —
/// never reported in an oblivious compilation — so that method needed one
/// additional, narrowly-scoped branch: when a value read resolves to a
/// field/property/method DECLARED IN A DIFFERENT ASSEMBLY than the current
/// compilation's own AND that sibling's own analysis proves it tainted,
/// assert <c>!!</c> directly, bypassing the flow-state gate. This is disjoint
/// from every existing intra-project branch (all of which require the SAME
/// assembly), so no existing single-compilation behavior changes.
/// </para>
/// </summary>
public class Issue2412CrossProjectObliviousNullabilityTranslationTests
{
    // ---- Issue's own minimal LibA/LibB repro -------------------------------

    private const string LibBSource = @"
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
}";

    [Fact]
    public void CrossProject_ObjectInitializerAssignment_FromReferencedInterfaceMember_InsertsForgiveness()
    {
        const string LibASource = @"
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
}";

        (string printedB, string printedA) = TranslateTwoProjects(LibBSource, LibASource);

        // LibB's own translation is unaffected: `IFoo.Name`/`Impl.Name` are
        // still promoted to `string?` purely from LibB's own `Other?.Name`
        // evidence (issue #914/#2285), independent of any sibling.
        // LibA's `Target.Name` is Target's OWN declared property, assigned
        // (not read) from the tainted `foo.Name` — it must stay non-nullable
        // `string` (issue #2412's own worked example: the fix must not
        // repaint an unrelated declaration's own type). Only the read of the
        // cross-project-tainted `foo.Name` at the consumption site gets `!!`
        // forgiveness.
        Assert.Contains("prop Name string", Compact(printedA));
        Assert.DoesNotContain("prop Name string?", Compact(printedA));
        Assert.Contains("Target{Name: foo.Name!!}", Compact(printedA));
    }

    [Fact]
    public void CrossProject_ReturnPosition_FromReferencedInterfaceMember_InsertsForgiveness()
    {
        const string LibASource = @"
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
}";

        (_, string printedA) = TranslateTwoProjects(LibBSource, LibASource);

        Assert.Contains("return foo.Name!!", Compact(printedA));
    }

    [Fact]
    public void CrossProject_MethodArgumentPosition_FromReferencedInterfaceMember_InsertsForgiveness()
    {
        const string LibASource = @"
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
}";

        (_, string printedA) = TranslateTwoProjects(LibBSource, LibASource);

        Assert.Contains("sink.Accept(foo.Name!!)", Compact(printedA));
    }

    [Fact]
    public void CrossProject_ArgumentToPromotedSiblingParameter_DoesNotInsertRuntimeAssertion()
    {
        const string libB = @"
namespace LibB
{
    public class Service
    {
        public void Accept(string value)
        {
            _ = value?.Length;
        }
    }
}";
        const string libA = @"
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
}";

        (string printedB, string printedA) = TranslateTwoProjects(libB, libA);

        Assert.Contains("func Accept(value string?)", Compact(printedB));
        Assert.Contains("service.Accept(settings?.Value)", Compact(printedA));
        Assert.DoesNotContain("service.Accept((settings?.Value)!!)", Compact(printedA));
    }

    [Fact]
    public void CrossProject_NamedDelegateParameter_StillReceivesRequiredAssertion()
    {
        const string libB = @"
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
}";
        const string libA = @"
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
}";

        (string printedB, string printedA) = TranslateTwoProjects(libB, libA);

        Assert.DoesNotContain("callback Callback?", Compact(printedB));
        Assert.Contains("service.Accept(callback!!)", Compact(printedA));
    }

    [Fact]
    public void CrossProject_FieldTarget_FromReferencedInterfaceMember_InsertsForgiveness()
    {
        const string LibASource = @"
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
}";

        (_, string printedA) = TranslateTwoProjects(LibBSource, LibASource);

        Assert.Contains("Holder{Name: foo.Name!!}", Compact(printedA));
    }

    // ---- Negative controls --------------------------------------------------

    [Fact]
    public void CrossProject_UnrelatedUntaintedSiblingMember_IsForgivenAtImportedBoundary()
    {
        // `Plain.Label` has no taint evidence, but its imported oblivious
        // reference contract is still T? to gsc and needs a target-aware bridge.
        const string libB = @"
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
        public string Label => ""fixed"";
    }
}";

        const string libA = @"
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
}";

        (string printedB, string printedA) = TranslateTwoProjects(libB, libA);

        Assert.Contains("prop Label string -> \"fixed\"", printedB);
        Assert.DoesNotContain("prop Label string? ", printedB);
        Assert.Contains("Target{Name: plain.Label!!}", Compact(printedA));
    }

    [Fact]
    public void CrossProject_NullableEnabledSiblingProject_Unaffected()
    {
        // A nullable-ENABLED sibling's OWN declared annotation drives promotion
        // (independent of ObliviousNullabilityAnalyzer, which never runs for an
        // enabled compilation) — the cross-project wiring must not perturb that
        // existing, already-correct path: a non-null `string` member stays a
        // bare, non-`!!` read downstream, and a genuinely nullable `string?`
        // member (real annotation, not taint) is read with the SAME forgiveness
        // an intra-project nullable-enabled reference would already get.
        const string libB = @"
#nullable enable
namespace LibB
{
    public class Enabled
    {
        public string NonNull => ""x"";

        public string? Nullable => null;
    }
}";

        const string libA = @"
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
}";

        (string printedB, string printedA) = TranslateTwoProjects(libB, libA, obliviousB: false);

        // `NonNull` is a plain, genuinely non-nullable `string` — no `!!`.
        // `Nullable` is a genuinely `string?`-annotated property (not
        // taint-promoted) — the ALREADY-correct nullable-enabled path
        // (independent of this fix) inserts `!!` from its own declared
        // annotation, and the cross-project wiring must not disturb that.
        Assert.Contains("Target{A: e.NonNull, B: e.Nullable!!}", Compact(printedA));
    }

    [Fact]
    public void CrossProject_SameSimpleMemberNameInTwoSiblings_UsesImportedContracts()
    {
        // Both siblings emit non-null source contracts, while the consumer sees
        // their independently imported oblivious reference contracts as T?.
        const string libC = @"
namespace LibC
{
    public interface IFoo
    {
        string Name { get; }
    }

    public class Impl : IFoo
    {
        public string Name => ""fixed-c"";
    }
}";

        LoadedCSharpProject projectB = LoadOblivious(LibBSource, "LibB");
        LoadedCSharpProject projectC = LoadOblivious(libC, "LibC");

        const string libA = @"
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
}";

        LoadedCSharpProject projectA = LoadOblivious(
            libA,
            "LibA",
            new MetadataReference[] { projectB.Compilation.ToMetadataReference(), projectC.Compilation.ToMetadataReference() });

        var siblings = new[] { projectA.Compilation, projectB.Compilation, projectC.Compilation };
        string printedC = TranslateProject(projectC, siblings);
        string printedA = TranslateProject(projectA, siblings);

        Assert.Contains("prop Name string {", printedC);
        Assert.DoesNotContain("prop Name string? {", printedC);

        Assert.Contains("TargetB{Name: foo.Name!!}", Compact(printedA));
        Assert.Contains("TargetC{Name: foo.Name!!}", Compact(printedA));
    }

    [Fact]
    public void CrossProject_ReverseDependentPropertyTaint_ForgivesInferredLocalReceiver()
    {
        const string data = @"
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
}";
        LoadedCSharpProject projectData = LoadOblivious(data, "Data");

        const string core = @"
using Data;

namespace Core
{
    public static class Reset
    {
        public static void Clear(Response response) { response.Items = null; }
    }
}";
        LoadedCSharpProject projectCore = LoadOblivious(
            core,
            "Core",
            new MetadataReference[] { projectData.Compilation.ToMetadataReference() });

        var siblings = new[] { projectData.Compilation, projectCore.Compilation };
        LoadedDocument document = Assert.Single(projectData.Documents);
        var context = new TranslationContext(
            projectData.Compilation,
            document.SemanticModel,
            document.FilePath,
            siblingCompilations: null,
            repositoryCompilations: siblings);
        string printed = GSharpPrinter.Print(
            new CSharpToGSharpTranslator().TranslateDocument(document, context));

        Assert.Contains("prop Items []?string", printed);
        Assert.Contains("return items!!.Length", printed);
    }

    [Fact]
    public void CrossProject_ReverseDependentRecordParameterTaint_WidensStoredContract()
    {
        const string data = @"
namespace Data
{
    public record Context(string Progress);
}";
        LoadedCSharpProject projectData = LoadOblivious(data, "Data");

        const string app = @"
using Data;

namespace App
{
    public static class Factory
    {
        public static Context Create() => new Context(null);
    }
}";
        LoadedCSharpProject projectApp = LoadOblivious(
            app,
            "App",
            new MetadataReference[] { projectData.Compilation.ToMetadataReference() });

        var repository = new[] { projectData.Compilation, projectApp.Compilation };
        LoadedDocument document = Assert.Single(projectData.Documents);
        var context = new TranslationContext(
            projectData.Compilation,
            document.SemanticModel,
            document.FilePath,
            siblingCompilations: null,
            repositoryCompilations: repository);
        string printed = GSharpPrinter.Print(
            new CSharpToGSharpTranslator().TranslateDocument(document, context));

        Assert.Contains("data class Context(Progress string?)", printed);
    }

    // ---- Transitive (three-project) chain: the real Oahu shape -------------

    [Fact]
    public void CrossProject_TransitiveThreeProjects_InterfaceMemberDeclaredInThirdProject_InsertsForgiveness()
    {
        // Mirrors Oahu exactly: `IBookMeta.Asin` (LibFoundation) is get-only and
        // carries NO evidence of its own; `Conversion.Asin` (LibData) is the
        // ONLY `?.`-seeded evidence, and LibData's OWN interface-implementation
        // edges (issue #2285) are what promote `IBookMeta.Asin` — a symbol
        // declared in a THIRD project — inside LibData's own taint fixpoint.
        // LibCore (the consumer) references LibData directly and LibFoundation
        // transitively; it must still insert `!!` for `book.Asin`.
        const string libFoundation = @"
namespace LibFoundation
{
    public interface IBookMeta
    {
        string Asin { get; }
    }
}";

        const string libData = @"
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
}";

        LoadedCSharpProject projectFoundation = LoadOblivious(libFoundation, "LibFoundation");
        LoadedCSharpProject projectData = LoadOblivious(
            libData, "LibData", new MetadataReference[] { projectFoundation.Compilation.ToMetadataReference() });

        const string libCore = @"
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
}";

        LoadedCSharpProject projectCore = LoadOblivious(
            libCore,
            "LibCore",
            new MetadataReference[]
            {
                projectData.Compilation.ToMetadataReference(),
                projectFoundation.Compilation.ToMetadataReference(),
            });

        var siblings = new[] { projectCore.Compilation, projectData.Compilation, projectFoundation.Compilation };
        string printedData = TranslateProject(projectData, siblings);
        string printedCore = TranslateProject(projectCore, siblings);

        // LibData's own standalone translation already promotes both endpoints
        // (issue #2285) — the interface member declared in Foundation AND its
        // own implementing property.
        Assert.Contains("prop Asin string? ->", printedData);

        // The regression: LibCore inserts the forgiveness for the Foundation-
        // declared interface member, whose only evidence lives in LibData.
        Assert.Contains("ContentReference{Asin: book.Asin!!}", Compact(printedCore));
    }

    // ---- Determinism / caching ----------------------------------------------

    [Fact]
    public void CrossProject_RepeatedTranslation_IsDeterministicAndConsistent()
    {
        const string LibASource = @"
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
}";

        LoadedCSharpProject projectB = LoadOblivious(LibBSource, "LibB");
        LoadedCSharpProject projectA = LoadOblivious(
            LibASource, "LibA", new MetadataReference[] { projectB.Compilation.ToMetadataReference() });
        var siblings = new[] { projectA.Compilation, projectB.Compilation };

        // Two INDEPENDENT translator instances (as every real pipeline stage
        // creates one per project) over the SAME loaded projects must agree —
        // the fix must not depend on incidental ordering of which project gets
        // translated (and therefore cached) first.
        string firstPrintedA = TranslateProject(projectA, siblings);
        string firstPrintedB = TranslateProject(projectB, siblings);
        string secondPrintedB = TranslateProject(projectB, siblings);
        string secondPrintedA = TranslateProject(projectA, siblings);

        Assert.Equal(firstPrintedA, secondPrintedA);
        Assert.Equal(firstPrintedB, secondPrintedB);
        Assert.Contains("Target{Name: foo.Name!!}", Compact(firstPrintedA));
        Assert.Contains("Target{Name: foo.Name!!}", Compact(secondPrintedA));
    }

    // ---- Helpers -------------------------------------------------------------

    private static (string PrintedB, string PrintedA) TranslateTwoProjects(
        string sourceB, string sourceA, bool obliviousB = true)
    {
        LoadedCSharpProject projectB = obliviousB
            ? LoadOblivious(sourceB, "LibB")
            : LoadEnabled(sourceB, "LibB");
        LoadedCSharpProject projectA = LoadOblivious(
            sourceA, "LibA", new MetadataReference[] { projectB.Compilation.ToMetadataReference() });

        var siblings = new[] { projectA.Compilation, projectB.Compilation };
        string printedB = TranslateProject(projectB, siblings);
        string printedA = TranslateProject(projectA, siblings);
        return (printedB, printedA);
    }

    private static LoadedCSharpProject LoadOblivious(
        string source, string assemblyName, IReadOnlyList<MetadataReference> extraReferences = null)
    {
        LoadedCSharpProject project = LoadWithReferences(source, assemblyName, extraReferences);
        Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions);
        return project;
    }

    private static LoadedCSharpProject LoadEnabled(
        string source, string assemblyName, IReadOnlyList<MetadataReference> extraReferences = null)
    {
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
        IReadOnlyList<MetadataReference> references = extraReferences is null
            ? CSharpProjectLoader.RuntimeReferences()
            : CSharpProjectLoader.RuntimeReferences().Concat(extraReferences).ToList();

        SyntaxTree tree = CSharpSyntaxTree.ParseText(
            source, new CSharpParseOptions(LanguageVersion.Latest), path: assemblyName + ".cs");
        CSharpCompilation compilation = CSharpCompilation.Create(
            assemblyName,
            new[] { tree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));

        var diagnostics = compilation.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error).ToList();
        Assert.True(diagnostics.Count == 0, $"{assemblyName} should bind with no C# errors: " + string.Join(Environment.NewLine, diagnostics));

        var document = new LoadedDocument(assemblyName + ".cs", tree, compilation.GetSemanticModel(tree));
        var project = new LoadedCSharpProject(compilation, new[] { document }, Array.Empty<Diagnostic>());
        Assert.NotEqual(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions);
        return project;
    }

    private static LoadedCSharpProject LoadWithReferences(
        string source, string assemblyName, IReadOnlyList<MetadataReference> extraReferences)
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

    private static string TranslateProject(
        LoadedCSharpProject project, IReadOnlyList<CSharpCompilation> siblingCompilations)
    {
        var translator = new CSharpToGSharpTranslator();
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation, document.SemanticModel, document.FilePath, siblingCompilations);
        CompilationUnit unit = translator.TranslateDocument(document, context);
        return PrintAndValidate(unit);
    }

    private static string PrintAndValidate(CompilationUnit unit)
    {
        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    // Collapses incidental whitespace/newlines around composite-literal braces
    // so an assertion on `Target{Name: foo.Name!!}` is not sensitive to the
    // printer's exact line-wrapping.
    private static string Compact(string printed) =>
        string.Join(" ", printed.Split(
            new[] { ' ', '\t', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries));
}
