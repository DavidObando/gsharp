// <copyright file="Issue1896RangeSliceTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #1896: a C# range-index expression (<c>a[1..3]</c>) was desugared to
/// <c>a.Slice(1, 3 - 1)</c> — gsc has no <c>Slice</c> member on arrays or
/// <c>string</c>, so every range-index form failed to compile (GS0159).
/// gsc actually has its OWN native range-index syntax
/// (<c>Parser.ParseIndexArgument</c>/<c>ParseIndexBound</c>), and its binder
/// (<c>ExpressionBinder.BindRangeSlice</c>) resolves it directly against
/// arrays, <c>string</c>, and any CLR span-like type with a
/// <c>Length</c>+<c>Slice(int,int)</c> shape or a <c>System.Range</c> indexer
/// — exactly the set of receivers C# itself allows a range index against. So
/// <c>CSharpToGSharpTranslator.TranslateRangeSlice</c> now emits the
/// unchanged native form (<c>GExpression.IndexExpression</c> wrapping a
/// <c>RangeIndexExpression</c>, the same node already used by the issue
/// #1889 list-pattern slice lowering) instead of desugaring to <c>.Slice</c>.
/// </summary>
public class Issue1896RangeSliceTranslationTests
{
    [Fact]
    public void ArrayRange_BothBounds_LowersToNativeRangeIndex()
    {
        string rendered = Render(@"
namespace Corpus.Issue1896
{
    public class Holder
    {
        public int[] Middle(int[] a) => a[1..3];
    }
}
");

        Assert.Contains("a[1..3]", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain(".Slice(", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ArrayRange_OpenStart_LowersToNativeRangeIndex()
    {
        string rendered = Render(@"
namespace Corpus.Issue1896
{
    public class Holder
    {
        public int[] Head(int[] a) => a[..2];
    }
}
");

        Assert.Contains("a[..2]", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain(".Slice(", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ArrayRange_OpenEnd_LowersToNativeRangeIndex()
    {
        string rendered = Render(@"
namespace Corpus.Issue1896
{
    public class Holder
    {
        public int[] Tail(int[] a) => a[1..];
    }
}
");

        Assert.Contains("a[1..]", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain(".Slice(", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ArrayRange_FullyOpen_LowersToNativeRangeIndex()
    {
        string rendered = Render(@"
namespace Corpus.Issue1896
{
    public class Holder
    {
        public int[] All(int[] a) => a[..];
    }
}
");

        Assert.Contains("a[..]", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain(".Slice(", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ArrayRange_FromEndBothBounds_LowersToNativeRangeIndex()
    {
        string rendered = Render(@"
namespace Corpus.Issue1896
{
    public class Holder
    {
        public int[] TailFromEnd(int[] a) => a[^2..];

        public int[] MiddleFromEnd(int[] a) => a[1..^1];
    }
}
");

        Assert.Contains("a[^2..]", rendered, StringComparison.Ordinal);
        Assert.Contains("a[1..^1]", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain(".Slice(", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void StringLiteralRange_LowersToNativeRangeIndex()
    {
        string rendered = Render(@"
namespace Corpus.Issue1896
{
    public class Holder
    {
        public string Slice() => ""gsharp""[1..4];
    }
}
");

        Assert.Contains("\"gsharp\"[1..4]", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain(".Slice(", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void StringVariableRange_OpenEnd_LowersToNativeRangeIndex()
    {
        string rendered = Render(@"
namespace Corpus.Issue1896
{
    public class Holder
    {
        public string Tail(string s) => s[2..];
    }
}
");

        Assert.Contains("s[2..]", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain(".Slice(", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
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
