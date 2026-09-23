// <copyright file="Issue1894IndexLocalTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #1894: a <c>System.Index</c>-typed local (<c>Index third = ^3;</c>)
/// used to print a bare G# <c>^3</c> that gsc read as one's-complement, so
/// the translator reported a loud CS2GS-GAP. ADR-0192 / issue #4350 made
/// prefix <c>^x</c> a first-class G# <c>System.Index</c> expression (and moved
/// one's-complement to <c>~x</c>), so saved, passed, and returned Index values
/// now translate verbatim. The inline bracket forms (<c>a[^3]</c>,
/// <c>a[1..^2]</c>) are unchanged.
/// </summary>
public class Issue1894IndexLocalTranslationTests
{
    [Fact]
    public void InlineFromEndIndex_InBracket_StaysCanonical()
    {
        // The one safe position for a bare `^n`: directly inside the index
        // bracket it indexes. This must keep working with no diagnostics.
        string rendered = Render(@"
namespace Corpus.Issue1894
{
    public class Holder
    {
        public int Get(int[] a) => a[^3];
    }
}
");

        Assert.Contains("a[^3]", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void TypeOfIndexAndRange_UseMetadataTypeNamesWithoutValueGap()
    {
        string rendered = Render(@"
using System;
namespace Corpus.Issue1894
{
    public class Holder
    {
        public Type IndexType() => typeof(Index);

        public Type RangeType() => typeof(Range);
    }
}
");

        Assert.Contains("typeof(Index)", rendered, StringComparison.Ordinal);
        Assert.Contains("typeof(Range)", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void InlineRangeSlice_FromEndBound_StaysCanonicalNoGap()
    {
        // `a[1..^2]`, `a[^2..]`, `a[..^1]`: the `^n` bound is nested inside a
        // `RangeExpressionSyntax` that is itself a direct bracket argument —
        // a valid, working inline slice. Issue #1896 root-caused this: gsc
        // has its OWN native range-index syntax, so the whole range (`^n`
        // bound included) now round-trips to the identical native G# form
        // instead of being desugared to `.Slice(...)`.
        string rendered = Render(@"
namespace Corpus.Issue1894
{
    public class Holder
    {
        public int[] Middle(int[] a) => a[1..^2];

        public int[] Tail(int[] a) => a[^2..];

        public int[] Head(int[] a) => a[..^1];
    }
}
");

        Assert.Contains("a[1..^2]", rendered, StringComparison.Ordinal);
        Assert.Contains("a[^2..]", rendered, StringComparison.Ordinal);
        Assert.Contains("a[..^1]", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain(".Slice(", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void InlineRangeSlice_FromEndBound_EvaluatesSideEffectingReceiverOnce()
    {
        // Issue #1896: the native `recv[start..^n]` form embeds `recv` exactly
        // once (unlike the retired `.Slice(...)` desugaring, which needed a
        // receiver spill to avoid a double-evaluated `receiver.Length` +
        // `.Slice(...)` pair). A side-effecting receiver (`Src()`) must still
        // be called exactly once, now with no spill temp at all.
        string rendered = Render(@"
namespace Corpus.Issue1894
{
    public class Holder
    {
        private static int[] Src() => new[] { 1, 2, 3, 4 };

        public int[] SideEffecting() => Src()[1..^2];

        public int[] Trivial(int[] a) => a[1..^2];
    }
}
");

        int sideEffectingStart = rendered.IndexOf("SideEffecting", StringComparison.Ordinal);
        int sideEffectingEnd = rendered.IndexOf("Trivial", StringComparison.Ordinal);
        string sideEffectingBody = rendered.Substring(sideEffectingStart, sideEffectingEnd - sideEffectingStart);
        int srcCallCount = System.Text.RegularExpressions.Regex.Matches(sideEffectingBody, @"Src\(\)").Count;
        Assert.Equal(1, srcCallCount);
        Assert.DoesNotContain("let __", sideEffectingBody, StringComparison.Ordinal);
        Assert.Contains("Src()[1..^2]", sideEffectingBody, StringComparison.Ordinal);

        string trivialBody = rendered.Substring(sideEffectingEnd);
        Assert.DoesNotContain("let __", trivialBody, StringComparison.Ordinal);
        Assert.Contains("a[1..^2]", trivialBody, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void IndexTypedLocal_FromFromEndLiteral_TranslatesToFirstClassIndex()
    {
        // The exact issue #1894 repro: `Index third = ^3; ... a[third];`.
        // ADR-0192 made `^3` a first-class G# System.Index expression, so the
        // saved value keeps its from-end meaning with no gap.
        string rendered = Render(@"
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
");

        Assert.Contains("= ^3", rendered, StringComparison.Ordinal);
        Assert.Contains("a[third]", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void VarInferredIndexLocal_TranslatesToFirstClassIndex()
    {
        string rendered = Render(@"
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
");

        Assert.Contains("let third = ^3", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void IndexTypedParameter_MapsToImportedIndex()
    {
        string rendered = Render(@"
using System;
namespace Corpus.Issue1894
{
    public class Holder
    {
        public int Get(int[] a, Index i) => a[i];
    }
}
");

        Assert.Contains("i Index", rendered, StringComparison.Ordinal);
        Assert.Contains("a[i]", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void IndexTypedReturn_ReturnsFromEndExpression()
    {
        string rendered = Render(@"
using System;
namespace Corpus.Issue1894
{
    public class Holder
    {
        public Index GetIndex() => ^1;
    }
}
");

        Assert.Contains("^1", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void FromEndBoundInRangeSlice_StaysCanonicalNoGap()
    {
        // `span[start..^n]`: the `^n` bound is nested inside a
        // `RangeExpressionSyntax` that is itself a direct bracket argument — a
        // valid, working inline slice, folded to `Length`-relative arithmetic
        // by `TranslateRangeBound` — NOT the same hazard as a bare `^n` stored
        // in a local or otherwise reused outside any bracket-scoped range.
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", @"
using System;
namespace Corpus.Issue1894
{
    public class Holder
    {
        public Span<int> GetSlice(int[] a) => a.AsSpan()[1..^2];
    }
}
") });

        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.DoesNotContain(context.Diagnostics, d => d.Message.Contains("from-end index", StringComparison.Ordinal));
    }

    private static void AssertRoundTripParses(string rendered)
    {
        RoundTripResult result = TranslationTestValidation.AssertBinds(rendered);

        Assert.True(
            result.Success,
            "Sanitized G# must round-trip-parse. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + rendered);
    }

    private static string Render(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", source) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        Cs2Gs.CodeModel.Ast.CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.Empty(context.Diagnostics);
        return GSharpPrinter.Print(unit);
    }
}
