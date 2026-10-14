// <copyright file="Issue1896RangeSliceTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #1896: a C# range-index expression (`a[1..3]`) was desugared to
/// `a.Slice(1, 3 - 1)` — gsc has no `Slice` member on arrays or
/// `string`, so every range-index form failed to compile (GS0159).
/// gsc actually has its OWN native range-index syntax
/// (`Parser.ParseIndexArgument`/`ParseIndexBound`), and its binder
/// (`ExpressionBinder.BindRangeSlice`) resolves it directly against
/// arrays, `string`, and any CLR span-like type with a
/// `Length`+`Slice(int,int)` shape or a `System.Range` indexer
/// — exactly the set of receivers C# itself allows a range index against. So
/// `CSharpToGSharpTranslator.TranslateRangeSlice` now emits the
/// unchanged native form (`GExpression.IndexExpression` wrapping a
/// `RangeIndexExpression`, the same node already used by the issue
/// #1889 list-pattern slice lowering) instead of desugaring to `.Slice`.
open class Issue1896RangeSliceTranslationTests {
    @Fact
    func ArrayRange_BothBounds_LowersToNativeRangeIndex() {
        let rendered = Render(`
namespace Corpus.Issue1896
{
    public class Holder
    {
        public int[] Middle(int[] a) => a[1..3];
    }
}
`)
        Assert.Contains("a[1..3]", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain(".Slice(", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ArrayRange_OpenStart_LowersToNativeRangeIndex() {
        let rendered = Render(`
namespace Corpus.Issue1896
{
    public class Holder
    {
        public int[] Head(int[] a) => a[..2];
    }
}
`)
        Assert.Contains("a[..2]", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain(".Slice(", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ArrayRange_OpenEnd_LowersToNativeRangeIndex() {
        let rendered = Render(`
namespace Corpus.Issue1896
{
    public class Holder
    {
        public int[] Tail(int[] a) => a[1..];
    }
}
`)
        Assert.Contains("a[1..]", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain(".Slice(", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ArrayRange_FullyOpen_LowersToNativeRangeIndex() {
        let rendered = Render(`
namespace Corpus.Issue1896
{
    public class Holder
    {
        public int[] All(int[] a) => a[..];
    }
}
`)
        Assert.Contains("a[..]", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain(".Slice(", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ArrayRange_FromEndBothBounds_LowersToNativeRangeIndex() {
        let rendered = Render(`
namespace Corpus.Issue1896
{
    public class Holder
    {
        public int[] TailFromEnd(int[] a) => a[^2..];

        public int[] MiddleFromEnd(int[] a) => a[1..^1];

        public int[] HeadTrimFromEnd(int[] a) => a[..^1];
    }
}
`)
        Assert.Contains("a[^2..]", rendered, StringComparison.Ordinal)
        Assert.Contains("a[1..^1]", rendered, StringComparison.Ordinal)
        Assert.Contains("a[..^1]", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain(".Slice(", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func StringLiteralRange_LowersToNativeRangeIndex() {
        let rendered = Render(`
namespace Corpus.Issue1896
{
    public class Holder
    {
        public string Slice() => "gsharp"[1..4];
    }
}
`)
        Assert.Contains("\"gsharp\"[1..4]", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain(".Slice(", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func StringVariableRange_OpenEnd_LowersToNativeRangeIndex() {
        let rendered = Render(`
namespace Corpus.Issue1896
{
    public class Holder
    {
        public string Tail(string s) => s[2..];
    }
}
`)
        Assert.Contains("s[2..]", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain(".Slice(", rendered, StringComparison.Ordinal)
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
