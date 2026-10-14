// <copyright file="Issue3501NegatedTypePropertyPatternTests.cs" company="GSharp">
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

/// Issue #3501 (GS0172/GS0173 family): a boolean-position C# `is not
/// T { props }` translates to a G# `not` over an `and`-combined
/// type+property pattern, but `not` binds tighter than `and` in gsc's
/// pattern grammar — printing the combinator child bare re-associated to
/// `(not T) and { props }`, so the property pattern escaped the negation and
/// was checked against the scrutinee's own (possibly nullable) type. The
/// printer now parenthesizes a combinator child of `not`.
open class Issue3501NegatedTypePropertyPatternTests {
    @Fact
    func NegatedTypeWithPropertyPattern_KeepsGroupingUnderNot() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class Node
    {
        public Node Inner { get; set; }
        public int Rank { get; set; }
    }

    public static class Probe
    {
        public static bool Reject(object value)
        {
            if (value is not Node { Rank: 3 })
            {
                return true;
            }

            return false;
        }
    }
}`)
        Assert.DoesNotContain("not Node and {", printed, StringComparison.Ordinal)
        Assert.True(
            printed.Contains("not (Node and { Rank: 3 })", StringComparison.Ordinal) || printed.Contains(
                "not Node { Rank: 3 }",
                StringComparison.Ordinal
            ) ||
                printed.Contains("!(value is Node", StringComparison.Ordinal),
            "The negation must cover the whole type+property pattern. Printed:\n" + printed
        )
    }

    shared {
        private func TranslateUnit(source string) string {
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
