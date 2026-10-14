// <copyright file="Issue1880UnsignedRightShiftTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #1880: C#'s unsigned (logical) right-shift `>>>` and its
/// compound-assign form `>>>=` had no translation. `>>>`
/// crashed the translator outright (`ArgumentException: Unknown binary
/// operator: >>>` from the G# printer's precedence table), and
/// `>>>=` emitted the C# token text verbatim into G# source that
/// gsc could not parse (since G# had no such operator). Both are now first-class
/// G# operators (see gsc's `SyntaxKind.UnsignedShiftRightToken` /
/// `UnsignedShiftRightEqualsToken`), so the translator now passes both
/// straight through unchanged for ALL integer operand types (int/uint/long/
/// ulong/etc — mirrors `>>`/`>>=`, which receive no numeric-
/// promotion coercion either).
open class Issue1880UnsignedRightShiftTranslationTests {
    @Fact
    func UnsignedRightShiftExpression_Int_TranslatesThrough() {
        let rendered = Render(`
namespace Corpus.Issue1880
{
    public class Holder
    {
        public int Shift(int value)
        {
            return value >>> 1;
        }
    }
}
`)
        Assert.Contains("value >>> 1", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func UnsignedRightShiftExpression_Long_TranslatesThrough() {
        let rendered = Render(`
namespace Corpus.Issue1880
{
    public class Holder
    {
        public long Shift(long value)
        {
            return value >>> 2;
        }
    }
}
`)
        Assert.Contains("value >>> 2", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func UnsignedRightShiftExpression_UInt_TranslatesThrough() {
        let rendered = Render(`
namespace Corpus.Issue1880
{
    public class Holder
    {
        public uint Shift(uint value)
        {
            return value >>> 3;
        }
    }
}
`)
        Assert.Contains("value >>> 3", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func UnsignedRightShiftAssignmentExpression_Int_TranslatesThrough() {
        let rendered = Render(`
namespace Corpus.Issue1880
{
    public class Holder
    {
        public int Shift(int value)
        {
            value >>>= 1;
            return value;
        }
    }
}
`)
        Assert.Contains("value >>>= 1", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func UnsignedRightShiftAssignmentExpression_ULong_TranslatesThrough() {
        let rendered = Render(`
namespace Corpus.Issue1880
{
    public class Holder
    {
        public ulong Shift(ulong value)
        {
            value >>>= 4;
            return value;
        }
    }
}
`)
        Assert.Contains("value >>>= 4", rendered, StringComparison.Ordinal)
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
