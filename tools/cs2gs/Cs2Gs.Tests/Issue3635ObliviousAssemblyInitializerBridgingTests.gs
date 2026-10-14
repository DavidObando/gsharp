// <copyright file="Issue3635ObliviousAssemblyInitializerBridgingTests.cs" company="GSharp">
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
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// Translator-fidelity tests for issue #3635: member reads from a
/// nullability-<em>oblivious</em> assembly (e.g. any netstandard2.0 reference,
/// which carries no NRT metadata) used to be imported by gsc as `T?`
/// (#1354, ADR-0136), so cs2gs bridged a read flowing into a non-nullable slot
/// with `!!`. The #2113 machinery covered return/receiver/foreach
/// positions but missed FIELD/PROPERTY INITIALIZERS: the migrated
/// netstandard2.0 `Gsharp.NET.Sdk` failed GS0155 on
/// `public string Optimization { get; set; } = bool.TrueString;`
/// (oblivious static FIELD read) and GS0156 on
/// `public ITaskItem[] References { get; set; } = Array.Empty<ITaskItem>();`
/// (oblivious method return in an initializer). Uses the
/// #2113 in-memory oblivious-library pattern; the consumer is
/// nullable-ENABLED, matching Gsharp.NET.Sdk (its own declarations stay
/// non-null `T`, only the oblivious READ is imported differently).
///
/// Since ADR-0186 step 3 gsc imports the oblivious read as the platform type
/// `T!` and checks it itself at the store, so these tests now pin that
/// cs2gs emits no `!!` on a scalar read (ADR-0186 step 6, PR 0). A
/// container read (the `string[]` returns) keeps its `!!`, which is
/// still load-bearing there (#4449). The test names
/// (`…Bridged`) predate ADR-0186 step 6 and are kept for issue
/// traceability; the assertions state the current contract.
open class Issue3635ObliviousAssemblyInitializerBridgingTests {
    @Fact
    func Enabled_AutoPropertyInitializer_ObliviousStaticFieldRead_Bridged() {
        // The Gsharp.NET.Sdk GS0155 shape: `= bool.TrueString` on an instance
        // auto-property, whose lowered backing field stays non-null `string`.
        let printed = TranslateEnabledWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public string Optimization { get; set; } = Ext.Name;
    }
}`)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("Ext.Name", printed)
        Assert.DoesNotContain("Ext.Name!!", printed)
    }

    @Fact
    func Enabled_AutoPropertyInitializer_ObliviousMethodReturn_Bridged() {
        // The Gsharp.NET.Sdk GS0156 shape: `= Array.Empty<ITaskItem>()` on an
        // instance auto-property — an oblivious method RETURN in an initializer.
        let printed = TranslateEnabledWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public string[] References { get; set; } = Ext.Items();
    }
}`)
        // A container read keeps its `!!` (ADR-0186 step 6, PR 0): the oblivious
        // `string[]` return reads as `[]!string!`, and only the `!!` lets it
        // convert to the enabled `[]string` slot (#4449).
        Assert.Contains("Ext.Items()!!", printed)
    }

    @Fact
    func Enabled_AutoPropertyInitializer_ObliviousStaticPropertyRead_Bridged() {
        // Nearby shape: an oblivious static PROPERTY read in an initializer,
        // handled like the field read.
        let printed = TranslateEnabledWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public string Title { get; set; } = Ext.Title;
    }
}`)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("Ext.Title", printed)
        Assert.DoesNotContain("Ext.Title!!", printed)
    }

    @Fact
    func Enabled_FieldInitializer_ObliviousMethodReturn_Bridged() {
        // Plain C# field initializer (not an auto-property lowering) with an
        // oblivious method return, which takes the pre-existing field path.
        let printed = TranslateEnabledWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        private string[] items = Ext.Items();

        public int Count() { return this.items.Length; }
    }
}`)
        // A container read keeps its `!!` (ADR-0186 step 6, PR 0): the oblivious
        // `string[]` return reads as `[]!string!`, and only the `!!` lets it
        // convert to the enabled `[]string` slot (#4449).
        Assert.Contains("Ext.Items()!!", printed)
    }

    @Fact
    func Enabled_GetOnlyAutoPropertyInitializer_LiftedToConstructor_Bridged() {
        // A get-only auto-property initializer is lifted into the explicit
        // constructor body (OD-T1); the lifted assignment targets the
        // property's non-null `string`.
        let printed = TranslateEnabledWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public C(int unused)
        {
        }

        public string Name { get; } = Ext.Name;
    }
}`)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("Ext.Name", printed)
        Assert.DoesNotContain("Ext.Name!!", printed)
    }

    @Fact
    func Enabled_ConstructorAssignment_ObliviousMethodReturn_Bridged() {
        // Nearby shape: an oblivious return assigned in a constructor body.
        let printed = TranslateEnabledWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public string[] Items { get; set; }

        public C()
        {
            this.Items = Ext.Items();
        }
    }
}`)
        // A container read keeps its `!!` (ADR-0186 step 6, PR 0): the oblivious
        // `string[]` return reads as `[]!string!`, and only the `!!` lets it
        // convert to the enabled `[]string` slot (#4449).
        Assert.Contains("Ext.Items()!!", printed)
    }

    @Fact
    func Oblivious_AutoPropertyInitializer_ObliviousStaticFieldRead_Bridged() {
        // Same GS0155 shape but with a nullable-OBLIVIOUS consumer (a project
        // with no <Nullable> setting at all): the untainted auto-property
        // renders non-null `string`.
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public string Optimization { get; set; } = Ext.Name;
    }
}`)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("Ext.Name", printed)
        Assert.DoesNotContain("Ext.Name!!", printed)
    }

    @Fact
    func Enabled_AutoPropertyInitializer_AnnotatedNonNullRead_NotBridged() {
        // Precision guard: `bool.TrueString` resolved against the ANNOTATED
        // modern runtime (non-null `string`) must NOT grow a `!!` (neither does
        // an oblivious read now; this guard predates ADR-0186 step 6). This
        // consumer references no oblivious library, so its emitted G# binds.
        let printed = TranslateEnabled(`
namespace Demo
{
    public class C
    {
        public string Optimization { get; set; } = bool.TrueString;
    }
}`)
        Assert.Contains("bool.TrueString", printed)
        Assert.DoesNotContain("bool.TrueString!!", printed)
    }

    shared {
        // The tiny "external" library compiled WITHOUT a nullable context: every
        // reference-typed member is oblivious (NullableAnnotation.None), exactly
        // like a netstandard2.0 reference assembly (e.g. Microsoft.Build.Framework).
        private const ObliviousLibrarySource string = `
public class Ext
{
    public static string Name = "n";

    public static string Title { get { return "t"; } }

    public static string[] Items() { return new string[0]; }
}`

        private func TranslateEnabledWithObliviousLibrary(source string) string -> TranslateWithObliviousLibrary(
            source,
            NullableContextOptions.Enable
        )

        private func TranslateObliviousWithObliviousLibrary(source string) string -> TranslateWithObliviousLibrary(
            source,
            NullableContextOptions.Disable
        )

        private func TranslateWithObliviousLibrary(source string, consumerNullability NullableContextOptions) string {
            let libTree = CSharpSyntaxTree.ParseText(ObliviousLibrarySource, CSharpParseOptions(LanguageVersion.Latest))
            let libCompilation = CSharpCompilation.Create(
                "ObliviousLib",
                []SyntaxTree{libTree},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Disable
                )
            )
            using let peStream = MemoryStream()
            let emit = libCompilation.Emit(peStream)
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
            peStream.Position = 0
            let libReference MetadataReference = MetadataReference.CreateFromStream(peStream)
            let parseOptions = CSharpParseOptions(LanguageVersion.Latest)
            let tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs")
            let compilation = CSharpCompilation.Create(
                "Cs2Gs.ObliviousAssemblyInMemory",
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences().Append(libReference).ToImmutableArray(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    consumerNullability
                )
                    .WithAllowUnsafe(true)
            )
            Assert.DoesNotContain(
                compilation.GetDiagnostics(),
                (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error
            )
            let model = compilation.GetSemanticModel(tree)
            let document = LoadedDocument("Snippet.cs", tree, model)
            let context = TranslationContext(compilation, model, document.FilePath)
            return PrintAndValidate(
                CSharpToGSharpTranslator().TranslateDocument(document, context),
                "Consumer-only fixture omits the referenced C# metadata library from emitted G#."
            )
        }

        private func TranslateEnabled(source string) string {
            let parseOptions = CSharpParseOptions(LanguageVersion.Latest)
            let tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs")
            let compilation = CSharpCompilation.Create(
                "Cs2Gs.EnabledInMemory",
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
                    .WithAllowUnsafe(true)
            )
            Assert.DoesNotContain(
                compilation.GetDiagnostics(),
                (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error
            )
            let model = compilation.GetSemanticModel(tree)
            let document = LoadedDocument("Snippet.cs", tree, model)
            let context = TranslationContext(compilation, model, document.FilePath)
            return PrintAndValidate(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        private func PrintAndValidate(unit CompilationUnit, roundTripOnlyReason string? = nil) string {
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = if roundTripOnlyReason == nil {
                TranslationTestValidation.AssertBinds(printed)
            } else {
                TranslationTestValidation.ValidateRoundTripOnly(printed, roundTripOnlyReason)
            }
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
