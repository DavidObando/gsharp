// <copyright file="Issue3501TuplePropertyArrowAmbiguityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import Xunit

/// Issue #3501: an expression-bodied property whose type renders with a
/// leading parenthesis (a tuple type, or a function type) cannot use the
/// ADR-0131 arrow-property spelling — `prop P (int64, int64) -> e`
/// re-parses as a function-TYPE annotation (`(int64, int64) -> E`)
/// and the emitted file fails the round-trip parse (the src/LanguageServer
/// SemanticLookup wall in the repo self-migration). Those properties render
/// with an arrow get accessor inside a block instead, where the type ends
/// unambiguously at the `{`.
open class Issue3501TuplePropertyArrowAmbiguityTests {
    @Fact
    func TupleTypedExpressionBodiedProperty_RendersAsArrowGetAccessor() {
        let g = Render(`
namespace N
{
    public class C
    {
        private long hits;
        private long misses;

        public (long, long) Stats => (this.hits, this.misses);
    }
}`)
        Assert.Contains("prop Stats (int64, int64) {", g, StringComparison.Ordinal)
        Assert.Contains("get -> (this.hits, this.misses)", g, StringComparison.Ordinal)
        Assert.DoesNotContain("prop Stats (int64, int64) ->", g, StringComparison.Ordinal)
    }

    @Fact
    func TupleTypedExpressionBodiedProperty_TranslatedGSharp_ParsesBindsAndCompiles() {
        let g = Render(`
namespace N
{
    public class C
    {
        private long hits;
        private long misses;

        public (long, long) Stats => (this.hits, this.misses);
    }
}`)
        let result = EmittedOracle.Evaluate([]string{g}, EmittedOracleOptions{IsLibrary: true})
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        Assert.Equal(0, result.ExitCode)
    }

    @Fact
    func TupleTypedExpressionBodiedIndexer_RendersAsArrowGetAccessor() {
        let g = Render(`
namespace N
{
    public class C
    {
        public (int, int) this[int i] => (i, i + 1);
    }
}`)
        Assert.Contains("prop this[i int32] (int32, int32) {", g, StringComparison.Ordinal)
        Assert.Contains("get -> (i, i + 1)", g, StringComparison.Ordinal)
    }

    @Fact
    func TupleArrayReturningExpressionBodiedMethod_RendersAsBlockBody() {
        // The nested slice-element type position absorbs a following arrow as a
        // function type (`(string, string) -> Expr`), unlike the TOP-LEVEL
        // tuple return, which gsc's parser explicitly disambiguates and which
        // keeps the flat arrow spelling (see Issue1278's tuple-returning test).
        let g = Render(`
namespace N
{
    public class C
    {
        public (string, string)[] Rows(bool first) =>
            first ? new[] { ("a", "b") } : new[] { ("c", "d") };
    }
}`)
        Assert.Contains("func Rows(first bool) [](string, string) {", g, StringComparison.Ordinal)
        Assert.DoesNotContain("[](string, string) ->", g, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate([]string{g}, EmittedOracleOptions{IsLibrary: true})
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        Assert.Equal(0, result.ExitCode)
    }

    @Fact
    func TupleArrayExpressionBodiedProperty_RendersAsArrowGetAccessor() {
        let g = Render(`
namespace N
{
    public class C
    {
        public (string, string)[] Rows => new[] { ("a", "b") };
    }
}`)
        Assert.Contains("prop Rows [](string, string) {", g, StringComparison.Ordinal)
        Assert.DoesNotContain("[](string, string) ->", g, StringComparison.Ordinal)
    }

    @Fact
    func TupleReturningExpressionBodiedMethod_KeepsArrowForm() {
        // The top-level tuple return stays on the flat arrow spelling — gsc's
        // parser disambiguates exactly this shape.
        let g = Render(`
namespace N
{
    public class C
    {
        private static (int, int) Pair() => (1, 2);
    }
}`)
        Assert.Contains("private func Pair() (int32, int32) -> (1, 2)", g, StringComparison.Ordinal)
    }

    @Fact
    func NonTupleExpressionBodiedProperty_KeepsArrowForm() {
        let g = Render(`
namespace N
{
    public class C
    {
        public string Tag => "x";
    }
}`)
        Assert.Contains("prop Tag string -> \"x\"", g, StringComparison.Ordinal)
    }

    shared {
        private func Render(csharp string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, csharp string){("Source.cs", csharp)})
            Assert.True(
                project.BoundWithoutErrors,
                "inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return GSharpPrinter.Print(unit)
        }
    }
}
