// <copyright file="Issue3501NullableSeamResidualTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import System
import Xunit

/// Issue #3501 residual nullability seams:
/// (1) a C# reference cast PRESERVES null — and so does `cast[T](expr)`
/// (ADR-0167), including over a nullable operand, so the cast of a
/// promoted-nullable operand stays `cast[T](expr)`. This assertion was
/// INVERTED by issue #3843: it previously demanded `expr as T`, on the premise
/// that `cast[T]` required a non-null operand. That premise was false for the
/// identity and downcast directions and has since been closed for the upcast
/// direction too, and `as` was the wrong rendering anyway — it yields `T?`
/// (breaking a non-nullable continuation) and returns nil where C# throws
/// `InvalidCastException`; and
/// (2) an iterator's element is the method's return sink, so a tainted
/// iterator (yielding promoted-nullable values) must render `sequence[T?]` —
/// previously the yield-seam bridge correctly stood down (the return IS
/// promoted) while the signature disagreed with its own yields.
open class Issue3501NullableSeamResidualTests {
    @Fact
    func Oblivious_ReferenceCastOfPromotedOperand_StaysCheckedConversionCall() {
        let printed = TranslateOblivious(`
namespace Demo
{
    public class Base { }
    public class Derived : Base { }

    public class Holder
    {
        public Derived Primary { get; set; }
        public Base Fallback { get; set; }

        public void Clear() { this.Primary = null; }

        public Base Pick()
        {
            return (Base)this.Primary ?? this.Fallback;
        }
    }
}`)
        Assert.Contains("cast[Base](", printed)
        Assert.DoesNotContain("as Base", printed)
    }

    @Fact
    func Oblivious_TaintedIterator_PromotesSequenceElement() {
        let printed = TranslateOblivious(`
using System.Collections.Generic;

namespace Demo
{
    public class C
    {
        public string Find(bool b)
        {
            if (b) { return null; }
            return "x";
        }

        public IEnumerable<string> Names(bool includeMissing)
        {
            if (includeMissing)
            {
                yield return null;
            }

            var candidate = Find(true);
            if (!string.IsNullOrEmpty(candidate))
            {
                yield return candidate;
            }
        }
    }
}`)
        Assert.Contains("Names(includeMissing bool) sequence[string?]", printed)
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
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
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
