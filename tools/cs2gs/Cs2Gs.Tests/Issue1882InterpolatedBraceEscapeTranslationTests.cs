// <copyright file="Issue1882InterpolatedBraceEscapeTranslationTests.cs" company="GSharp">
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
/// Issue #1882: C#'s <c>{{</c>/<c>}}</c> interpolated-string brace escapes
/// were copied verbatim into the G# output instead of being unescaped.
/// Roslyn's <c>InterpolatedStringTextSyntax.TextToken.ValueText</c> does NOT
/// unescape brace doubling (only C-style escapes like <c>\n</c> go through
/// <c>ValueText</c>; brace doubling is an interpolated-string-grammar concept,
/// not a token escape). G# has no bare <c>{expr}</c> hole syntax at all
/// (only <c>${expr}</c>/<c>$ident</c>, see src/Core/CodeAnalysis/Syntax/Lexer.cs),
/// so <c>{</c>/<c>}</c> are always plain literal characters in G# — in both
/// interpolated and non-interpolated strings — and need no escaping.
/// </summary>
public class Issue1882InterpolatedBraceEscapeTranslationTests
{
    [Fact]
    public void InterpolatedString_DoubledBraces_UnescapeToSingleLiteralBraces()
    {
        string rendered = Render(@"
namespace Corpus.Issue1882
{
    public class Holder
    {
        public string Describe()
        {
            return $""braces={{x}} dollar=$9.99"";
        }
    }
}
");

        Assert.Contains("\"braces={x} dollar=$$9.99\"", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("{{", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("}}", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void InterpolatedString_DoubledBracesAroundRealHole_KeepsHoleAndUnescapesBraces()
    {
        string rendered = Render(@"
namespace Corpus.Issue1882
{
    public class Holder
    {
        public string Describe(int x)
        {
            return $""braces={{{x}}} hole={x}"";
        }
    }
}
");

        // literal '{' + hole(x) + literal '}' + literal " hole=" + hole(x).
        Assert.Contains("{$x} hole=$x", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void PlainStringLiteral_BracesNeedNoEscaping()
    {
        string rendered = Render(@"
namespace Corpus.Issue1882
{
    public class Holder
    {
        public string Describe()
        {
            return ""plain braces: {x} and {{y}}"";
        }
    }
}
");

        // A non-interpolated C# string literal has no brace-escape grammar at
        // all: `{{` is just two literal braces already, unaffected by this fix.
        Assert.Contains("\"plain braces: {x} and {{y}}\"", rendered, StringComparison.Ordinal);
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
