// <copyright file="Issue1881CheckedUncheckedTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #1881: cs2gs silently dropped C# `checked`/`unchecked`
/// overflow semantics. A `checked(expr)`/`unchecked(expr)`
/// expression fell to the expression fallback (reported as CS2GS-GAP), and a
/// `checked { }`/`unchecked { }` statement translated to a plain
/// block — silently erasing the overflow-trap behavior (the worst kind of
/// divergence: the migrated program compiles and runs, but disagrees on
/// stdout with the C# oracle). gsc now has native `checked`/`unchecked`
/// expression and block support, so both forms translate directly with no
/// gap and no silent behavior change.
open class Issue1881CheckedUncheckedTranslationTests {
    @Fact
    func CheckedExpression_TranslatesToCheckedExpression_NoGap() {
        let rendered = Render(`
namespace Corpus.Issue1881
{
    public static class E
    {
        public static int Run(int a, int b)
        {
            return checked(a + b);
        }
    }
}
`)
        Assert.Contains("checked(a + b)", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func UncheckedExpression_TranslatesToUncheckedExpression_NoGap() {
        let rendered = Render(`
namespace Corpus.Issue1881
{
    public static class E
    {
        public static int Run(int a, int b)
        {
            return unchecked(a + b);
        }
    }
}
`)
        Assert.Contains("unchecked(a + b)", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func CheckedExpression_NarrowingConversion_TranslatesToCheckedExpression() {
        let rendered = Render(`
namespace Corpus.Issue1881
{
    public static class E
    {
        public static byte Run(int wide)
        {
            return checked((byte)wide);
        }
    }
}
`)
        Assert.Contains("checked(", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func CheckedStatement_TranslatesToCheckedBlock_NotPlainBlock() {
        let rendered = Render(`
namespace Corpus.Issue1881
{
    public static class E
    {
        public static int Run(int a, int b)
        {
            int result = 0;
            checked
            {
                result = a + b;
            }

            return result;
        }
    }
}
`)
        // The pre-fix translator emitted a plain `{ }` block here, silently
        // erasing the overflow-trap semantics (issue #1881's core bug).
        Assert.Contains("checked {", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func UncheckedStatement_TranslatesToUncheckedBlock_NotPlainBlock() {
        let rendered = Render(`
namespace Corpus.Issue1881
{
    public static class E
    {
        public static int Run(int a, int b)
        {
            int result = 0;
            unchecked
            {
                result = a + b;
            }

            return result;
        }
    }
}
`)
        Assert.Contains("unchecked {", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func CheckedStatement_NestedUnchecked_BothContextsTranslate() {
        let rendered = Render(`
namespace Corpus.Issue1881
{
    public static class E
    {
        public static int Run(int a, int b)
        {
            int result = 0;
            checked
            {
                unchecked
                {
                    result = a + b;
                }
            }

            return result;
        }
    }
}
`)
        Assert.Contains("checked {", rendered, StringComparison.Ordinal)
        Assert.Contains("unchecked {", rendered, StringComparison.Ordinal)
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
            Assert.DoesNotContain(
                context.Diagnostics,
                (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
            )
            return GSharpPrinter.Print(unit)
        }
    }
}
