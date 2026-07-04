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
/// translated to <c>let third = ^3</c> — a bare G# `^3` printed OUTSIDE an
/// index bracket. gsc's own grammar only recognises a leading `^` as a
/// from-end marker directly inside `[...]` (Parser.ParseIndexBound);
/// everywhere else it is the one's-complement operator, so the printed local
/// silently bound to <c>~3</c> (<c>-4</c>) instead of "3 from the end" and
/// <c>a[third]</c> crashed at runtime with <c>IndexOutOfRangeException</c>.
/// G# has no <c>System.Index</c>/<c>System.Range</c> value type, so this
/// cannot be lowered correctly in general (a stored from-end value has no
/// collection to re-materialize the offset against at an arbitrary later use
/// site) — the translator now reports a loud CS2GS-GAP instead of silently
/// emitting the wrong value, at both of the two independent choke points that
/// can produce one:
/// <list type="bullet">
/// <item>any expression whose static type is <c>Index</c>/<c>Range</c>
/// (local, parameter, field, property, return type) — <see
/// cref="CSharpTypeMapper.MapCore"/> via <see
/// cref="CSharpTypeMapper.IsSystemIndexOrRange"/>.</item>
/// <item>a bare from-end marker <c>^n</c> printed anywhere other than the
/// direct bracket-argument position it is safe in (a local initializer,
/// method argument, or return statement) — the
/// <c>PrefixUnaryExpressionSyntax</c> case in
/// <c>CSharpToGSharpTranslator.TranslateExpression</c>.</item>
/// </list>
/// The direct inline case, <c>a[^3]</c>, is unaffected: it still lowers to
/// the bare native G# <c>a[^3]</c>. An inline range bound, <c>a[1..^2]</c>,
/// is also unaffected: <c>CSharpToGSharpTranslator.TranslateRangeBound</c>
/// folds it into <c>Length</c>-relative arithmetic instead of gapping.
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
    public void InlineRangeSlice_FromEndBound_StaysCanonicalNoGap()
    {
        // `a[1..^2]`, `a[^2..]`, `a[..^1]`: the `^n` bound is nested inside a
        // `RangeExpressionSyntax` that is itself a direct bracket argument —
        // a valid, working inline slice (folded to `Length`-relative
        // arithmetic by `TranslateRangeBound`), not the #1894 silent-
        // miscompile shape (a bare `^n` stored/reused outside any bracket).
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

        Assert.Contains(".Slice(", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void InlineRangeSlice_FromEndBound_SpillsSideEffectingReceiverOnce()
    {
        // Regression: `TranslateRangeBound` re-embeds the receiver inside
        // `receiver.Length` alongside the `.Slice(...)` call built in
        // `TranslateRangeSlice` — a side-effecting receiver (`Src()`) must be
        // evaluated exactly once, not twice, when a from-end bound is
        // present. A trivial identifier receiver (`a`) must stay unchanged,
        // no spill temp introduced.
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
        Assert.Contains("let __spill", sideEffectingBody, StringComparison.Ordinal);

        string trivialBody = rendered.Substring(sideEffectingEnd);
        Assert.DoesNotContain("let __", trivialBody, StringComparison.Ordinal);
        Assert.Contains("a.Slice(", trivialBody, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void IndexTypedLocal_FromFromEndLiteral_StaysLoudGap()
    {
        // The exact issue #1894 repro: `Index third = ^3; ... a[third];`.
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", @"
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
") });

        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.Contains(context.Diagnostics, d => d.Message.Contains("System.Index", StringComparison.Ordinal));
        Assert.Contains(context.Diagnostics, d => d.Message.Contains("issue #1894", StringComparison.Ordinal));
        Assert.All(context.Diagnostics, d => Assert.Equal(TranslationSeverity.Unsupported, d.Severity));
    }

    [Fact]
    public void VarInferredIndexLocal_StaysLoudGap()
    {
        // `var` inferring System.Index must gap identically to the explicit
        // `Index` type clause — the local symbol's bound type is what is
        // checked, not the written type syntax.
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", @"
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
") });

        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.Contains(context.Diagnostics, d => d.Message.Contains("System.Index", StringComparison.Ordinal));
    }

    [Fact]
    public void IndexTypedParameter_StaysLoudGap()
    {
        // An Index-typed parameter is not a from-end literal at all — it can
        // arrive from anywhere at the call site — so it must gap at the type
        // choke point (CSharpTypeMapper), independent of the literal-^n case.
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", @"
using System;
namespace Corpus.Issue1894
{
    public class Holder
    {
        public int Get(int[] a, Index i) => a[i];
    }
}
") });

        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.Contains(context.Diagnostics, d => d.Message.Contains("System.Index", StringComparison.Ordinal));
    }

    [Fact]
    public void IndexTypedReturn_StaysLoudGap()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", @"
using System;
namespace Corpus.Issue1894
{
    public class Holder
    {
        public Index GetIndex() => ^1;
    }
}
") });

        Assert.True(project.BoundWithoutErrors, string.Join("\n", project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.Contains(context.Diagnostics, d => d.Message.Contains("System.Index", StringComparison.Ordinal));
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
        RoundTripResult result = GSharpRoundTrip.Validate(rendered);

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
