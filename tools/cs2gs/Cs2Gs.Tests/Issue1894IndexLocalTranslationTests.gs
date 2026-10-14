// <copyright file="Issue1894IndexLocalTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Linq
import System.Text.RegularExpressions
import Xunit

/// Issue #1894: a `System.Index`-typed local (`Index third = ^3;`)
/// used to print a bare G# `^3` that gsc read as one's-complement, so
/// the translator reported a loud CS2GS-GAP. ADR-0187 / issue #4350 made
/// prefix `^x` a first-class G# `System.Index` expression (and moved
/// one's-complement to `~x`), so saved, passed, and returned Index values
/// now translate verbatim. The inline bracket forms (`a[^3]`,
/// `a[1..^2]`) are unchanged.
open class Issue1894IndexLocalTranslationTests {
    @Fact
    func InlineFromEndIndex_InBracket_StaysCanonical() {
        // The one safe position for a bare `^n`: directly inside the index
        // bracket it indexes. This must keep working with no diagnostics.
        let rendered = Render(`
namespace Corpus.Issue1894
{
    public class Holder
    {
        public int Get(int[] a) => a[^3];
    }
}
`)
        Assert.Contains("a[^3]", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func TypeOfIndexAndRange_UseMetadataTypeNamesWithoutValueGap() {
        let rendered = Render(`
using System;
namespace Corpus.Issue1894
{
    public class Holder
    {
        public Type IndexType() => typeof(Index);

        public Type RangeType() => typeof(Range);
    }
}
`)
        Assert.Contains("typeof(Index)", rendered, StringComparison.Ordinal)
        Assert.Contains("typeof(Range)", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func InlineRangeSlice_FromEndBound_StaysCanonicalNoGap() {
        // `a[1..^2]`, `a[^2..]`, `a[..^1]`: the `^n` bound is nested inside a
        // `RangeExpressionSyntax` that is itself a direct bracket argument —
        // a valid, working inline slice. Issue #1896 root-caused this: gsc
        // has its OWN native range-index syntax, so the whole range (`^n`
        // bound included) now round-trips to the identical native G# form
        // instead of being desugared to `.Slice(...)`.
        let rendered = Render(`
namespace Corpus.Issue1894
{
    public class Holder
    {
        public int[] Middle(int[] a) => a[1..^2];

        public int[] Tail(int[] a) => a[^2..];

        public int[] Head(int[] a) => a[..^1];
    }
}
`)
        Assert.Contains("a[1..^2]", rendered, StringComparison.Ordinal)
        Assert.Contains("a[^2..]", rendered, StringComparison.Ordinal)
        Assert.Contains("a[..^1]", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain(".Slice(", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func InlineRangeSlice_FromEndBound_EvaluatesSideEffectingReceiverOnce() {
        // Issue #1896: the native `recv[start..^n]` form embeds `recv` exactly
        // once (unlike the retired `.Slice(...)` desugaring, which needed a
        // receiver spill to avoid a double-evaluated `receiver.Length` +
        // `.Slice(...)` pair). A side-effecting receiver (`Src()`) must still
        // be called exactly once, now with no spill temp at all.
        let rendered = Render(`
namespace Corpus.Issue1894
{
    public class Holder
    {
        private static int[] Src() => new[] { 1, 2, 3, 4 };

        public int[] SideEffecting() => Src()[1..^2];

        public int[] Trivial(int[] a) => a[1..^2];
    }
}
`)
        let sideEffectingStart = rendered.IndexOf("SideEffecting", StringComparison.Ordinal)
        let sideEffectingEnd = rendered.IndexOf("Trivial", StringComparison.Ordinal)
        let sideEffectingBody = rendered.Substring(sideEffectingStart, sideEffectingEnd - sideEffectingStart)
        let srcCallCount = Regex.Matches(sideEffectingBody, "Src\\(\\)").Count
        Assert.Equal(1, srcCallCount)
        Assert.DoesNotContain("let __", sideEffectingBody, StringComparison.Ordinal)
        Assert.Contains("Src()[1..^2]", sideEffectingBody, StringComparison.Ordinal)
        let trivialBody = rendered.Substring(sideEffectingEnd)
        Assert.DoesNotContain("let __", trivialBody, StringComparison.Ordinal)
        Assert.Contains("a[1..^2]", trivialBody, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func IndexTypedLocal_FromFromEndLiteral_TranslatesToFirstClassIndex() {
        // The exact issue #1894 repro: `Index third = ^3; ... a[third];`.
        // ADR-0187 made `^3` a first-class G# System.Index expression, so the
        // saved value keeps its from-end meaning with no gap.
        let rendered = Render(`
using System;
namespace Corpus.Issue1894
{
    public class Holder
    {
        public int Get(int[] a)
        {
            Index third = ^3;
            return a[third];
        }
    }
}
`)
        Assert.Contains("= ^3", rendered, StringComparison.Ordinal)
        Assert.Contains("a[third]", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func VarInferredIndexLocal_TranslatesToFirstClassIndex() {
        let rendered = Render(`
namespace Corpus.Issue1894
{
    public class Holder
    {
        public int Get(int[] a)
        {
            var third = ^3;
            return a[third];
        }
    }
}
`)
        Assert.Contains("let third = ^3", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func IndexTypedParameter_MapsToImportedIndex() {
        let rendered = Render(`
using System;
namespace Corpus.Issue1894
{
    public class Holder
    {
        public int Get(int[] a, Index i) => a[i];
    }
}
`)
        Assert.Contains("i Index", rendered, StringComparison.Ordinal)
        Assert.Contains("a[i]", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func IndexTypedReturn_ReturnsFromEndExpression() {
        let rendered = Render(`
using System;
namespace Corpus.Issue1894
{
    public class Holder
    {
        public Index GetIndex() => ^1;
    }
}
`)
        Assert.Contains("^1", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func FromEndBoundInRangeSlice_StaysCanonicalNoGap() {
        // `span[start..^n]`: the `^n` bound is nested inside a
        // `RangeExpressionSyntax` that is itself a direct bracket argument — a
        // valid, working inline slice, folded to `Length`-relative arithmetic
        // by `TranslateRangeBound` — NOT the same hazard as a bare `^n` stored
        // in a local or otherwise reused outside any bracket-scoped range.
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", `
using System;
namespace Corpus.Issue1894
{
    public class Holder
    {
        public Span<int> GetSlice(int[] a) => a.AsSpan()[1..^2];
    }
}
`)})
        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Message!!.Contains("from-end index", StringComparison.Ordinal)
        )
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
