// <copyright file="Issue2015RawInterpolatedStringBraceTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #2015: follow-up to #1882's `{{`/`}}` unescape fix. That fix
/// assumed a hole-delimiter width of exactly 1 brace (the classic `$"..."`
/// form), where a doubled brace run is C#'s "escaped literal single brace".
/// Raw interpolated strings with N>=2 leading `$` signs (`$$"""..."""`,
/// `$$$"""..."""`, ...) use a WIDER hole delimiter of N consecutive braces:
/// per the C# spec, a brace run SHORTER than N is embedded verbatim (no escaping
/// at all), so blindly collapsing `{{` to `{` would corrupt literal
/// text that legitimately contains a two-brace run. This must only unescape for
/// N==1 and copy raw (N>=2) interpolated-string text verbatim.
open class Issue2015RawInterpolatedStringBraceTranslationTests {
    @Fact
    func ClassicOneDollarInterpolatedString_DoubledBraces_StillUnescape() {
        let rendered = Render(`
namespace Corpus.Issue2015
{
    public class Holder
    {
        public string Describe()
        {
            return $"braces={{x}} literal";
        }
    }
}
`)
        Assert.Contains("\"braces={x} literal\"", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("{{", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ThreeDollarRawInterpolatedString_LiteralDoubleBraces_DoNotCollapse() {
        // N=3 raw interpolated string: hole delimiter is `{{{` / `}}}`. A run of
        // two braces is shorter than N, so it is literal text and must NOT be
        // collapsed to a single brace by the (N==1-only) unescape logic.
        let rendered = Render(`namespace Corpus.Issue2015
{
    public class Holder
    {
        public string Describe()
        {
            return $$$"""literal braces: {{ and }} stay doubled""";
        }
    }
}`)
        Assert.Contains("literal braces: {{ and }} stay doubled", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ThreeDollarRawInterpolatedString_ActualHole_TranslatesInterpolation() {
        // N=3 raw interpolated string with an actual interpolation hole, opened
        // and closed with exactly three braces each side.
        let rendered = Render(`namespace Corpus.Issue2015
{
    public class Holder
    {
        public string Describe(int x)
        {
            return $$$"""value={{{x}}} done""";
        }
    }
}`)
        Assert.Contains("value=$$x done", rendered, StringComparison.Ordinal)
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
