// <copyright file="Issue1273ExpressionBodiedAccessorTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #1273 / #1278 (ADR-0131): G# now has a first-class expression-bodied
/// member form using the lambda arrow `->` (never the C# fat arrow
/// `=>`). cs2gs therefore translates a C# expression-bodied member
/// (`public int Expr => 7;` or an explicit `get => e` /
/// `set => e`) into the idiomatic G# arrow form
/// (`prop Expr int32 -> 7`, `get -> e`, `set -> e`),
/// never emitting a fat arrow `=>` in the output.
open class Issue1273ExpressionBodiedAccessorTranslationTests {
    @Fact
    func ExpressionBodiedProperty_RendersAsPropertyLevelArrow() {
        let rendered = Render()
        // The expression-bodied read-only property becomes `prop Expr int32 -> 7`.
        Assert.Contains("prop Expr int32 -> 7", rendered, StringComparison.Ordinal)
        // It should NOT fall back to a get-block body for this simple case.
        Assert.DoesNotContain("get { return 7", rendered, StringComparison.Ordinal)
    }

    @Fact
    func TranslatedOutput_ContainsNoFatArrow() {
        let rendered = Render()
        // G# never uses the C# fat arrow; the arrow form is `->`.
        Assert.DoesNotContain("=>", rendered, StringComparison.Ordinal)
    }

    @Fact
    func ExpressionBodiedGetter_RendersAsArrowAccessor() {
        let rendered = Render()
        // `get => this.n` becomes `get -> this.n`, not a block body.
        Assert.Contains("get -> this.n", rendered, StringComparison.Ordinal)
    }

    @Fact
    func ExpressionBodiedSetter_RendersAsArrowAccessor() {
        let rendered = Render()
        // `set => this.n = value` becomes `set -> this.n = value`, not `set { }`.
        Assert.Contains("set -> this.n = value", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("set { this.n", rendered, StringComparison.Ordinal)
    }

    shared {
        private const Source string = `
namespace Corpus.Issue1273
{
    public class Widget
    {
        private int n;

        public int Expr => 7;

        public int Pair
        {
            get => this.n;
            set => this.n = value;
        }
    }
}
`

        private func Render() string {
            let (unit, _) = Translate()
            return GSharpPrinter.Print(unit)
        }

        private func Translate()(Unit CompilationUnit, Context TranslationContext) {
            let project = CSharpProjectLoader.LoadInMemory([](string, Source string){("Widget.cs", Source)})
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
            return (unit, context)
        }
    }
}
