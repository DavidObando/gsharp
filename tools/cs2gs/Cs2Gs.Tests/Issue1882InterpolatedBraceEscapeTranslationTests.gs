// <copyright file="Issue1882InterpolatedBraceEscapeTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #1882: C#'s `{{`/`}}` interpolated-string brace escapes
/// were copied verbatim into the G# output instead of being unescaped.
/// Roslyn's `InterpolatedStringTextSyntax.TextToken.ValueText` does NOT
/// unescape brace doubling (only C-style escapes like `\n` go through
/// `ValueText`; brace doubling is an interpolated-string-grammar concept,
/// not a token escape). G# has no bare `{expr}` hole syntax at all
/// (only `${expr}`/`$ident`, see src/Core/CodeAnalysis/Syntax/Lexer.cs),
/// so `{`/`}` are always plain literal characters in G# — in both
/// interpolated and non-interpolated strings — and need no escaping.
open class Issue1882InterpolatedBraceEscapeTranslationTests {
    @Fact
    func InterpolatedString_DoubledBraces_UnescapeToSingleLiteralBraces() {
        let rendered = Render(`
namespace Corpus.Issue1882
{
    public class Holder
    {
        public string Describe()
        {
            return $"braces={{x}} dollar=$9.99";
        }
    }
}
`)
        Assert.Contains("\"braces={x} dollar=$$$$9.99\"", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("{{", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("}}", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func InterpolatedString_DoubledBracesAroundRealHole_KeepsHoleAndUnescapesBraces() {
        let rendered = Render(`
namespace Corpus.Issue1882
{
    public class Holder
    {
        public string Describe(int x)
        {
            return $"braces={{{x}}} hole={x}";
        }
    }
}
`)
        // literal '{' + hole(x) + literal '}' + literal " hole=" + hole(x).
        Assert.Contains("{$$x} hole=$$x", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func PlainStringLiteral_BracesNeedNoEscaping() {
        let rendered = Render(`
namespace Corpus.Issue1882
{
    public class Holder
    {
        public string Describe()
        {
            return "plain braces: {x} and {{y}}";
        }
    }
}
`)
        // A non-interpolated C# string literal has no brace-escape grammar at
        // all: `{{` is just two literal braces already, unaffected by this fix.
        Assert.Contains("\"plain braces: {x} and {{y}}\"", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    shared {
        private func AssertRoundTripParses(rendered string) {
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(rendered)
            Assert.True(
                result!!.Success,
                "Sanitized G# must round-trip-parse. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + rendered
            )
        }

        private func Render(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Source.cs", source)})
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
            Assert.Empty(context.Diagnostics)
            return GSharpPrinter.Print(unit)
        }
    }
}
