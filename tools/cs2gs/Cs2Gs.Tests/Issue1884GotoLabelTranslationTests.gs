// <copyright file="Issue1884GotoLabelTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #1884 (ADR-0139): the C#→G# translator maps `goto`/labels to
/// G#'s general `goto`/label surface syntax, and lowers `goto case`
/// / `goto default` to a plain `goto` targeting a synthesized label
/// placed at the top of the matching `switch` arm's translated body
/// (neither re-evaluates the switch subject, matching C# semantics).
open class Issue1884GotoLabelTranslationTests {
    @Fact
    func LabeledStatement_And_PlainGoto_TranslateToGSharpLabelAndGoto() {
        let rendered = Render(`
namespace Corpus.Issue1884
{
    public class Loop
    {
        public int Retry()
        {
            int a = 0;
        retry:
            a++;
            if (a < 3)
            {
                goto retry;
            }

            return a;
        }
    }
}
`)
        Assert.Contains("retry:", rendered, StringComparison.Ordinal)
        Assert.Contains("goto retry", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func GotoCase_LowersToGotoOfSynthesizedLabelAtMatchingArm() {
        let rendered = Render(`
namespace Corpus.Issue1884
{
    public class Switcher
    {
        public string Run(int value)
        {
            string trace = "";
            switch (value)
            {
                case 1:
                    trace += "one";
                    goto case 2;
                case 2:
                    trace += "two";
                    break;
                default:
                    trace += "other";
                    break;
            }

            return trace;
        }
    }
}
`)
        // Issue #3501 A3: the trailing `goto case 2;` targets the LEXICALLY
        // NEXT arm, so it is exactly Go's `fallthrough` — the native gsc
        // statement replaces the synthesized-label lowering.
        Assert.Contains("fallthrough", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("__gotoCase", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func GotoCase_NonAdjacentTarget_StillLowersToSynthesizedLabel() {
        let rendered = Render(`
namespace Corpus.Issue1884
{
    public class Switcher
    {
        public string Run(int value)
        {
            string trace = "";
            switch (value)
            {
                case 1:
                    trace += "one";
                    goto case 3;
                case 2:
                    trace += "two";
                    break;
                case 3:
                    trace += "three";
                    break;
            }

            return trace;
        }
    }
}
`)
        // A goto that skips over an arm cannot be a fallthrough; it keeps
        // the synthesized-label lowering (issue #1884).
        Assert.Contains("goto __gotoCase", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("fallthrough", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func GotoDefault_LowersToGotoOfSynthesizedLabelAtDefaultArm() {
        let rendered = Render(`
namespace Corpus.Issue1884
{
    public class Switcher
    {
        public string Run(int value)
        {
            string trace = "";
            switch (value)
            {
                case 7:
                    trace += "seven";
                    goto default;
                default:
                    trace += "other";
                    break;
            }

            return trace;
        }
    }
}
`)
        // Issue #3501 A3: `goto default` targeting the lexically next arm is
        // Go's `fallthrough`; the synthesized-label lowering remains only for
        // non-adjacent targets (see GotoCase_NonAdjacentTarget test).
        Assert.Contains("fallthrough", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("__gotoDefault", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func LabelIdentifier_CollidingWithGSharpKeyword_IsSanitized() {
        let rendered = Render(`
namespace Corpus.Issue1884
{
    public class KeywordLabel
    {
        public int Run()
        {
            int n = 0;
        @goto:
            n++;
            if (n < 2)
            {
                goto @goto;
            }

            return n;
        }
    }
}
`)
        // `goto` is a G# reserved word (see SyntaxFacts), so the C#
        // verbatim label `@goto` must be suffixed to a valid G# identifier at
        // both its declaration and every reference.
        Assert.Contains("goto_:", rendered, StringComparison.Ordinal)
        Assert.Contains("goto goto_", rendered, StringComparison.Ordinal)
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
