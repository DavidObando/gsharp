// <copyright file="Issue1890TypePatternTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #1890: a bare-type C# switch-arm pattern (`int =>`, no
/// binder — Roslyn's `TypePatternSyntax`) had no canonical G# form and
/// reported the CS2GS-GAP "pattern 'TypePattern' has no canonical G# form
/// yet". G#'s own `TypePattern` grammar always requires a designator
/// before `is`, but treats `_` as a real discard there
/// (`PatternBinder.BindTypePattern`'s `isDiscard` check), so the
/// bare arm lowers to `_ is T` with no binding introduced.
open class Issue1890TypePatternTranslationTests {
    @Fact
    func SwitchExpression_BareTypeArms_LowerToDiscardTypePatterns() {
        let rendered = Render(`
namespace Corpus.Issue1890
{
    public class Widget
    {
    }

    public class Holder
    {
        public string Describe(object mystery) => mystery switch
        {
            int => "int",
            Widget => "widget",
            _ => "other",
        };
    }
}
`)
        Assert.Contains("case _ is int32:", rendered, StringComparison.Ordinal)
        Assert.Contains("case _ is Widget:", rendered, StringComparison.Ordinal)
        Assert.Contains("default:", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func SwitchStatement_BareTypeArm_LowersToDiscardTypePattern() {
        let rendered = Render(`
namespace Corpus.Issue1890
{
    public class Holder
    {
        public string Describe(object mystery)
        {
            switch (mystery)
            {
                case string:
                    return "string";
                default:
                    return "other";
            }
        }
    }
}
`)
        Assert.Contains("case _ is string {", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func SwitchExpression_BareTypeArmInsideOrCombinator_LowersToDiscardTypePattern() {
        let rendered = Render(`
namespace Corpus.Issue1890
{
    public class Holder
    {
        public string Describe(object mystery) => mystery switch
        {
            int or long => "whole number",
            _ => "other",
        };
    }
}
`)
        Assert.Contains("case _ is int32 or _ is int64:", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func SwitchExpression_QualifiedBareTypeArm_LowersToDiscardTypePattern() {
        // Issue #2258: a fully-qualified bare-type arm (`App.Auth.MfaChallenge =>`)
        // is parsed by Roslyn as a ConstantPattern over a MemberAccessExpression
        // (NOT a TypeSyntax), so it must be recognized as a type reference via its
        // resolved symbol and lowered to `_ is T` — otherwise it renders as a bare
        // value expression that gsc rejects (GS0157).
        let rendered = Render(`
namespace App.Auth
{
    public class Challenge { }
    public sealed class MfaChallenge : Challenge { }

    public class Holder
    {
        public string Describe(Challenge c) => c switch
        {
            App.Auth.MfaChallenge => "mfa",
            _ => "other",
        };
    }
}
`)
        Assert.Contains("case _ is MfaChallenge:", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("case App.Auth.MfaChallenge:", rendered, StringComparison.Ordinal)
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
