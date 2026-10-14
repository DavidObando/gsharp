// <copyright file="Issue1883LiteralReceiverMemberCallTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #1883: a member call on a bare numeric-literal receiver
/// (`42.ToString()`, `7.Squared()`) previously translated
/// verbatim, but G#'s grammar never chains postfix member/index/call
/// access directly onto a numeric-literal token (ADR-0054) — the lexer
/// cannot otherwise tell whether the following `.` starts a float's
/// fractional part or a member access, so the grammar simply disallows the
/// chain. The unparenthesized output failed to round-trip-parse
/// (GS0005/GS0157). Two C# shapes trigger this: string concatenation with a
/// non-string literal operand (`"n=" + 42`, which lowers to an
/// explicit `.ToString()` call) and a direct extension-method or
/// instance-member call on an int literal (`7.Squared()`,
/// `42.ToString()`, `42.GetType()`). The fix parenthesizes any
/// receiver that renders as a bare int/float literal wherever it is used
/// as a member-access/call receiver — covering every numeric-literal
/// spelling (decimal, hex, octal, binary, and suffixed forms) uniformly,
/// while leaving non-literal receivers (identifiers, calls, existing
/// parenthesized expressions) untouched.
open class Issue1883LiteralReceiverMemberCallTranslationTests {
    @Fact
    func IntLiteral_ConcatenatedWithString_ParenthesizesToStringReceiver() {
        let rendered = Render(`
namespace Corpus.Issue1883
{
    public class C
    {
        public string M()
        {
            return "n=" + 42;
        }
    }
}
`)
        Assert.Contains("(42).ToString()", rendered)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func NegativeLiteral_ConcatenatedWithString_ParenthesizesToStringReceiver() {
        let rendered = Render(`
namespace Corpus.Issue1883
{
    public class C
    {
        public string M()
        {
            return "n=" + -5;
        }
    }
}
`)
        Assert.Contains("(-5).ToString()", rendered)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func IntLiteral_DirectExtensionMethodCall_ParenthesizesReceiver() {
        let rendered = Render(`
namespace Corpus.Issue1883
{
    public static class Extensions
    {
        public static int Squared(this int value) => value * value;
    }

    public class C
    {
        public int M()
        {
            return 7.Squared();
        }
    }
}
`)
        Assert.Contains("(7).Squared()", rendered)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func IntLiteral_DirectToStringCall_ParenthesizesReceiver() {
        let rendered = Render(`
namespace Corpus.Issue1883
{
    public class C
    {
        public string M()
        {
            return 42.ToString();
        }
    }
}
`)
        Assert.Contains("(42).ToString()", rendered)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func LongAndHexLiterals_DirectMemberCall_ParenthesizesReceiver() {
        let rendered = Render(`
namespace Corpus.Issue1883
{
    public class C
    {
        public string M()
        {
            return 42L.ToString() + 0x2AU.ToString();
        }
    }
}
`)
        Assert.Contains("(42L).ToString()", rendered)
        Assert.Contains("(0x2AU).ToString()", rendered)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func NonLiteralReceiver_IsNotParenthesized() {
        let rendered = Render(`
namespace Corpus.Issue1883
{
    public class C
    {
        public string M(int n)
        {
            return n.ToString();
        }
    }
}
`)
        Assert.Contains("n.ToString()", rendered)
        Assert.DoesNotContain("(n).ToString()", rendered)
        AssertRoundTripParses(rendered)
    }

    shared {
        private func AssertRoundTripParses(rendered string) {
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(rendered)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip-parse. Errors:\n" + string.Join("\n", result!!.Errors) + `

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
            Assert.DoesNotContain(
                context.Diagnostics,
                (d TranslationDiagnostic) -> d.Severity != TranslationSeverity.Info
            )
            return GSharpPrinter.Print(unit)
        }
    }
}
