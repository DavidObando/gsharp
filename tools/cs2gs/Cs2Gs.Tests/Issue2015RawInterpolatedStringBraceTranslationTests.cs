// <copyright file="Issue2015RawInterpolatedStringBraceTranslationTests.cs" company="GSharp">
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
/// Issue #2015: follow-up to #1882's <c>{{</c>/<c>}}</c> unescape fix. That fix
/// assumed a hole-delimiter width of exactly 1 brace (the classic <c>$"..."</c>
/// form), where a doubled brace run is C#'s "escaped literal single brace".
/// Raw interpolated strings with N&gt;=2 leading <c>$</c> signs (<c>$$"""..."""</c>,
/// <c>$$$"""..."""</c>, ...) use a WIDER hole delimiter of N consecutive braces:
/// per the C# spec, a brace run SHORTER than N is embedded verbatim (no escaping
/// at all), so blindly collapsing <c>{{</c> to <c>{</c> would corrupt literal
/// text that legitimately contains a two-brace run. This must only unescape for
/// N==1 and copy raw (N&gt;=2) interpolated-string text verbatim.
/// </summary>
public class Issue2015RawInterpolatedStringBraceTranslationTests
{
    [Fact]
    public void ClassicOneDollarInterpolatedString_DoubledBraces_StillUnescape()
    {
        string rendered = Render(@"
namespace Corpus.Issue2015
{
    public class Holder
    {
        public string Describe()
        {
            return $""braces={{x}} literal"";
        }
    }
}
");

        Assert.Contains("\"braces={x} literal\"", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("{{", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ThreeDollarRawInterpolatedString_LiteralDoubleBraces_DoNotCollapse()
    {
        // N=3 raw interpolated string: hole delimiter is `{{{` / `}}}`. A run of
        // two braces is shorter than N, so it is literal text and must NOT be
        // collapsed to a single brace by the (N==1-only) unescape logic.
        string rendered = Render(""""
namespace Corpus.Issue2015
{
    public class Holder
    {
        public string Describe()
        {
            return $$$"""literal braces: {{ and }} stay doubled""";
        }
    }
}
"""");

        Assert.Contains("literal braces: {{ and }} stay doubled", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ThreeDollarRawInterpolatedString_ActualHole_TranslatesInterpolation()
    {
        // N=3 raw interpolated string with an actual interpolation hole, opened
        // and closed with exactly three braces each side.
        string rendered = Render(""""
namespace Corpus.Issue2015
{
    public class Holder
    {
        public string Describe(int x)
        {
            return $$$"""value={{{x}}} done""";
        }
    }
}
"""");

        Assert.Contains("value=$x done", rendered, StringComparison.Ordinal);
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
