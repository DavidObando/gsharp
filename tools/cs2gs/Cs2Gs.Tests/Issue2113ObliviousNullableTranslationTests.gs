// <copyright file="Issue2113ObliviousNullableTranslationTests.cs" company="GSharp">
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

/// Translator-fidelity tests for issue #2113: in a nullable-<em>oblivious</em>
/// compilation (`NullableContextOptions.Disable`, i.e. a project with no
/// `<Nullable>` setting) Roslyn reports every reference type as
/// `NullableAnnotation.None` with no flow state, so an oblivious reference
/// `T` used to always map to non-null G# `T`. That collided with the
/// `T?` values cs2gs legitimately introduces (`?.`, `= null`
/// defaults, nullable-returning BCL), producing GS0154/GS0155/GS0156 "T? vs T"
/// errors. The whole-program taint analysis
/// ((cref:ObliviousNullabilityAnalyzer)) now promotes a reference
/// declaration to `T?` exactly when it is reachable from a null value, and
/// keeps a provably non-null declaration as `T`. The analysis is gated to
/// oblivious compilations, so a nullable-<em>enabled</em> compilation is untouched.
open class Issue2113ObliviousNullableTranslationTests {
    @Fact
    func Oblivious_NullTaintedField_RendersNullableType() {
        // `field` is assigned null on one path, so it is null-tainted and must
        // render `string?`; without promotion the later `field = null` assignment
        // is a GS0155 "cannot convert nil to string".
        let printed = TranslateOblivious(`
namespace Demo
{
    public class C
    {
        private string field = "seed";

        public void Clear() { this.field = null; }
    }
}`)
        Assert.Contains("field string?", printed)
    }

    @Fact
    func Oblivious_NullTaintedParameterAndReturn_RenderNullableTypes() {
        // `Find` returns null on a path (return type tainted) and its result flows
        // into the `value` parameter of `Use` via a call argument (interprocedural
        // taint), so both the return and the parameter must render `string?`.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class C
    {
        public string Find(bool b)
        {
            if (b) { return null; }
            return "x";
        }

        public void Use(string value) { }

        public void Run() { Use(Find(true)); }
    }
}`)
        Assert.Contains("Find(b bool) string?", printed)
        Assert.Contains("Use(value string?)", printed)
    }

    @Fact
    func Oblivious_UntaintedReference_StaysNonNull() {
        // No null ever reaches `Name`, `Greet`, or its parameter, so all stay
        // non-null `string` — the idiomatic G# form.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class C
    {
        private string Name = "hello";

        public string Greet(string who) { return who; }
    }
}`)
        Assert.Contains("Name string", printed)
        Assert.DoesNotContain("Name string?", printed)
        Assert.Contains("Greet(who string) string", printed)
        Assert.DoesNotContain("string?", printed)
    }

    @Fact
    func NullableEnabled_DeclarationsUnchanged_NoObliviousPromotion() {
        // Same null-assignment shape as the oblivious field test, but in a
        // nullable-ENABLED compilation. The oblivious taint analysis must NOT run:
        // `field` is a declared non-null `string` (assigning null is a C# warning,
        // not a promotion trigger), so it stays non-null `string` exactly as
        // before #2113. `maybe` is declared `string?` and stays nullable.
        let printed = TranslateEnabled(`
namespace Demo
{
    public class C
    {
        private string field = "seed";
        private string? maybe = null;

        public void Keep() { this.field = this.field; }
    }
}`)
        Assert.Contains("field string", printed)
        Assert.DoesNotContain("field string?", printed)
        Assert.Contains("maybe string?", printed)
    }

    @Fact
    func Oblivious_ForEachOverObliviousExternalCall_ForgivesSource() {
        // `Ext.Get()` comes from an assembly compiled WITHOUT a nullable context,
        // so Roslyn reports its `List<int>` return as oblivious (NullableAnnotation
        // .None). gsc used to import it as `List[int32]?` (ADR-0136), which
        // rejected a plain `for x in ext.Get()` (GS0116), so cs2gs asserted
        // `ext.Get()!!`. The foreach source still throws on nil, as in C#.
        // (The test name predates ADR-0186 step 6; kept for issue traceability.)
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public void Run(Ext ext)
        {
            foreach (var x in ext.Get()) { }
        }
    }
}`)
        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("for x in ext.Get()", printed)
        Assert.DoesNotContain("for x in ext.Get()!!", printed)
    }

    @Fact
    func Oblivious_ForEachOverLocalFromObliviousExternalCall_ForgivesSource() {
        // Same as above but the oblivious external result is bound to a `let` local
        // first (`let items = ext.Get()`). gsc used to infer the local as
        // `List[int32]?`; since ADR-0186 step 3 it infers the platform type
        // `List[int32]!`. cs2gs still asserts `items!!` at the local's use site
        // because ADR-0186 step 6 PR 0 trims only direct metadata reads; the `!!`
        // is legal on `T!` and only redundant with gsc's own check.
        let printed = TranslateObliviousWithObliviousLibrary(`
namespace Demo
{
    public class C
    {
        public void Run(Ext ext)
        {
            var items = ext.Get();
            foreach (var x in items) { }
        }
    }
}`)
        Assert.Contains("for x in items!!", printed)
    }

    shared {
        private func TranslateObliviousWithObliviousLibrary(source string) string {
            // A tiny "external" library compiled WITHOUT a nullable context: its
            // `Get()` return type is oblivious (NullableAnnotation.None), exactly like
            // an unannotated NuGet package (e.g. System.Management).
            let libTree = CSharpSyntaxTree.ParseText(
                "public class Ext { public System.Collections.Generic.List<int> Get() { return null; } }",
                CSharpParseOptions(LanguageVersion.Latest)
            )
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
                "Cs2Gs.ObliviousExternalInMemory",
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences().Append(libReference).ToImmutableArray(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Disable
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

        private func TranslateOblivious(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            return PrintAndValidate(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        private func TranslateEnabled(source string) string {
            let parseOptions = CSharpParseOptions(LanguageVersion.Latest)
            let tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs")
            let compilation = CSharpCompilation.Create(
                "Cs2Gs.EnabledInMemory",
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences().Select((r MetadataReference) -> r).ToImmutableArray(),
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
