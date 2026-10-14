// <copyright file="Issue1528VerbatimIdentifierTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Linq
import Xunit

/// Issue #1528: a C# verbatim identifier whose bare name collides with a G#
/// reserved word (e.g. `@default`, a field literally named `default`)
/// must be sanitized consistently at every emission site. The declaration path
/// already routed through `SanitizeIdentifier` (emitting `default_`),
/// but two `TranslateIdentifierName` qualifier paths (implicit-receiver and
/// bare-static-member) and the `GenericNameSyntax`-as-expression paths
/// emitted the raw identifier text, so a bare `@default` reference became the
/// unparsable `TreeDecomposition.@default` (GS0005: unexpected AtToken) and
/// mismatched its own `default_` declaration. All reference sites must now
/// sanitize to `default_`.
open class Issue1528VerbatimIdentifierTranslationTests {
    @Fact
    func VerbatimKeywordStaticFieldReference_IsSanitizedConsistently() {
        let rendered = Render()
        // ADR-0170: the metadata-visible static field keeps its CLR name via
        // the escape at the declaration and every reference.
        Assert.Contains("$$default", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("default_", rendered, StringComparison.Ordinal)
        // The unparsable verbatim/keyword forms never leak into the output.
        Assert.DoesNotContain("@default", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain(".default ", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain(".default${Environment.NewLine}", rendered, StringComparison.Ordinal)
    }

    @Fact
    func SanitizedOutput_RoundTripParses() {
        let rendered = Render()
        let result RoundTripResult? = TranslationTestValidation.AssertBinds(rendered)
        Assert.True(
            result!!.Success,
            "Sanitized G# must round-trip-parse. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + rendered
        )
    }

    shared {
        private const Source string = `
namespace Corpus.Issue1528
{
    public class Holder<T>
        where T : new()
    {
        private static Holder<T> @default;

        public static Holder<T> Instance()
        {
            if (@default is null)
            {
                @default = new Holder<T>();
            }

            return @default;
        }
    }
}
`

        private func Render() string {
            let project = CSharpProjectLoader.LoadInMemory([](string, Source string){("Holder.cs", Source)})
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
