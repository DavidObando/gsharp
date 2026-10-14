// <copyright file="Issue2157ObliviousPropertyTaintTranslationTests.cs" company="GSharp">
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
import System.Linq
import Xunit

/// Translator-fidelity tests for issue #2157: in a nullable-<em>oblivious</em>
/// compilation the whole-program taint analysis
/// ((cref:ObliviousNullabilityAnalyzer)) must scan property / indexer
/// getters (expression body, `get => expr;`, and block-bodied
/// `get { ... return x; }`) so a getter whose body yields a nullable value
/// (`?.`, `??` with a nullable fallback, `return null`) is emitted
/// with a `T?` return type. Before the fix such a property was emitted as a
/// non-null `T` even though its `?.` body types as `T?`, producing
/// GS0156 "Cannot convert type 'string?' to 'string'". The analysis is gated to
/// oblivious compilations, so a nullable-<em>enabled</em> compilation is untouched.
open class Issue2157ObliviousPropertyTaintTranslationTests {
    @Fact
    func Oblivious_ExpressionBodiedProperty_WithConditionalAccessBody_RendersNullable() {
        // `Meta?.Asin` is a conditional access → its result is `string?`. The
        // property must therefore be emitted `string?` or gsc reports GS0156.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Meta { public string Asin = "x"; }

    public class Book
    {
        public Meta Meta = new Meta();

        public string Asin => Meta?.Asin;
    }
}`)
        Assert.Contains("prop Asin string?", printed)
    }

    @Fact
    func Oblivious_ExpressionBodiedProperty_WithCoalesceNullableFallbackBody_RendersNullable() {
        // `First()?.Name ?? Other` — the `??` fallback (`Other`) is itself a `?.`
        // result, so the whole expression is nullable and the property is `string?`.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Meta { public string Name = "x"; }

    public class Book
    {
        public Meta Meta = new Meta();
        public Meta Other = new Meta();

        public string Display => Meta?.Name ?? Other?.Name;
    }
}`)
        Assert.Contains("prop Display string?", printed)
    }

    @Fact
    func Oblivious_BlockBodiedGetter_WithReturnNull_RendersNullable() {
        // A block-bodied `get { ... return null; }` taints the property return.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Book
    {
        public bool Missing = true;

        public string Title
        {
            get
            {
                if (Missing) { return null; }
                return "t";
            }
        }
    }
}`)
        Assert.Contains("prop Title string?", printed)
    }

    @Fact
    func Oblivious_UntaintedComputedProperty_StaysNonNull() {
        // A getter that can never yield null keeps the idiomatic non-null `string`.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Book
    {
        public string First = "a";
        public string Last = "b";

        public string Full => First + Last;
    }
}`)
        Assert.Contains("prop Full string", printed)
        Assert.DoesNotContain("prop Full string?", printed)
    }

    @Fact
    func Oblivious_ValueTypedComputedProperty_IsNotPromoted() {
        // A value-typed property is never promoted even when the body is a `?.`
        // chain (its type is not a reference type).
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Meta { public int Count = 3; }

    public class Book
    {
        public Meta Meta = new Meta();

        public int Count => Meta == null ? 0 : Meta.Count;
    }
}`)
        Assert.Contains("prop Count int32", printed)
        Assert.DoesNotContain("prop Count int32?", printed)
    }

    @Fact
    func Oblivious_IndexerWithConditionalAccessBody_RendersNullable() {
        // An indexer getter yielding `string?` must be emitted `T?` too.
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Meta { public string Get(int i) { return "x"; } }

    public class Book
    {
        public Meta Meta = new Meta();

        public string this[int i] => Meta?.Get(i);
    }
}`)
        Assert.Contains("prop this[i int32] string?", printed)
    }

    @Fact
    func NullableEnabled_ComputedPropertyWithConditionalAccessBody_StaysNonNull() {
        // Same `?.` body but in a nullable-ENABLED compilation: the oblivious
        // taint analysis must NOT run, and the property is emitted exactly as its
        // declared non-null `string`.
        let printed = TranslateEnabled(`
#nullable enable
namespace Demo
{
    public class Meta { public string Asin = "x"; }

    public class Book
    {
        public Meta Meta = new Meta();

        public string Asin => Meta.Asin;
    }
}`)
        Assert.Contains("prop Asin string", printed)
        Assert.DoesNotContain("prop Asin string?", printed)
    }

    shared {
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
