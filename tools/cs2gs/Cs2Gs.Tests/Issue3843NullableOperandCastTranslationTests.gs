// <copyright file="Issue3843NullableOperandCastTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #3843: a C# explicit reference cast over a NULLABLE operand stays
/// `cast[T](expr)` — it must not become `expr as T`.
///
/// The canonical repro is cs2gs's own
/// `CSharpToGSharpTranslator.PragmaSuppressions.cs`:
/// `Select(t => (PragmaWarningDirectiveTriviaSyntax)t.GetStructure())
/// .Where(d => d is not null).OrderBy(d => d.SpanStart)`. Lowering the
/// cast to `as` made the element type `T?`, and a sequence-level
/// `Where` does not narrow an ELEMENT type, so the emitted G# disagreed
/// with itself one line later — a nullable lambda parameter feeding a
/// non-nullable continuation (GS0158 / GS0154). It took nine apps red in
/// #3831. `cast[T]`'s result is non-nullable `T`, exactly as the C#
/// cast's type is `T`, so the chain stays consistent.
///
/// The runtime half of the same defect — `as` yields nil where C#
/// `(T)x` throws (cref:InvalidCastException) — is proved by the
/// EXECUTING tests in
/// `test/Core.Tests/.../Issue3843NullableOperandCheckedCastTests.cs`,
/// because no compile-time or ILVerify check can see it.
open class Issue3843NullableOperandCastTranslationTests {
    @Fact
    func AnnotatedNullableOperand_SelectCastWhereNotNull_KeepsNonNullableElement() {
        let printed = Translate(`
#nullable enable
using System.Collections.Generic;
using System.Linq;

namespace Demo
{
    public class Structure { public int SpanStart { get; set; } }
    public class Pragma : Structure { public string Keyword { get; set; } = ""; }

    public class Trivia
    {
        public Structure? GetStructure() => null;
    }

    public class Scanner
    {
        public List<Pragma> Collect(IEnumerable<Trivia> trivia)
        {
            return trivia
                .Select(t => (Pragma)t.GetStructure())
                .Where(d => d is not null)
                .OrderBy(d => d.SpanStart)
                .ToList();
        }
    }
}`)
        // The cast keeps the checked conversion-call form...
        Assert.Contains("cast[Pragma](", printed)
        Assert.DoesNotContain("as Pragma", printed)
        // ...and the chain is INTERNALLY CONSISTENT: every lambda in it
        // takes the same element type, and the dereference that follows the
        // filter carries its own assertion. The `as` lowering printed
        // `.Where((d Pragma?) -> ...)` immediately followed by
        // `.OrderBy((d Pragma) -> d.SpanStart)` — a nullable element feeding
        // a non-nullable continuation, which is what stopped compiling
        // (GS0158 / GS0154). `Translate` above proves it binds; these pin the
        // shape so a future regression is legible.
        Assert.Contains(".Where((d Pragma?) -> d != nil)", printed)
        Assert.Contains(".OrderBy((d Pragma?) -> d!!.SpanStart)", printed)
    }

    @Fact
    func ObliviousPromotedOperand_CastStaysCheckedConversionCall() {
        let printed = Translate(`
namespace Demo
{
    public class Base { }
    public class Derived : Base { public int Value; }

    public class Holder
    {
        public Derived Primary;

        public void Clear() { this.Primary = null; }

        public int Read()
        {
            return ((Derived)(Base)this.Primary).Value;
        }
    }
}`)
        Assert.Contains("cast[Derived](", printed)
        Assert.DoesNotContain(" as Derived", printed)
    }

    shared {
        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(result!!.Success, "Translated G# must bind. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed)
            return printed
        }
    }
}
