// <copyright file="Issue3638InterpolationEscapedQuoteTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3638: a MULTILINE interpolated string is lowered to a concatenation
/// of backtick raw segments and hole values (issue #3501), but a non-atomic
/// hole expression (<c>{i + 1}</c>) got the synthetic <c>.ToString()</c>
/// appended without parentheses — <c>i + 1.ToString()</c> — which does not
/// even parse when the trailing operand is a numeric literal (ADR-0054: no
/// postfix chain on a bare numeric token, GS0005 on the DotToken) and is
/// semantically wrong wherever it does. The escaped-quote segments themselves
/// (<c>\"</c> in the C# literal) render correctly: quote-bearing single-line
/// chunks keep the escaped double-quoted form and multi-line chunks become
/// fully-literal backtick raws, both of which the G# lexer accepts.
/// </summary>
public class Issue3638InterpolationEscapedQuoteTests
{
    [Fact]
    public void MultilineInterpolation_EscapedQuotesAndExpressionHole_ParenthesizesHoleAndRoundTrips()
    {
        // The Adr0158SyncMapSpikeTests shape: escaped quotes, `{{`/`}}` brace
        // escapes, a plain `{i}` hole, and a non-atomic `{i + 1}` hole.
        string rendered = Render(@"
namespace Corpus.Issue3638
{
    public class Holder
    {
        public string Source(int i)
        {
            return $""func setK{i}(m SyncMap) int32 {{\n    m.Store(\""k{i}\"", {i + 1})\n    return 0\n}}"";
        }
    }
}
");

        Assert.Contains("(i + 1).ToString()", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("1.ToString", rendered.Replace("(i + 1).ToString", string.Empty), StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void MultilineInterpolation_PlainIdentifierHole_NeedsNoParentheses()
    {
        string rendered = Render(@"
namespace Corpus.Issue3638
{
    public class Holder
    {
        public string Source(int i)
        {
            return $""line1 {i}\nline2 \""x\""\nline3"";
        }
    }
}
");

        Assert.Contains("i.ToString()", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("(i).ToString()", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void MultilineVerbatimInterpolation_EscapedQuotesAndExpressionHole_ParenthesizesHoleAndRoundTrips()
    {
        // Verbatim `$@""...""` uses `""""` quote escapes and real newlines but
        // flows through the same classic single-dollar machinery.
        string rendered = Render(@"
namespace Corpus.Issue3638
{
    public class Holder
    {
        public string Source(int i)
        {
            return $@""b.F{i} = {i + 1} says """"hi""""
line2
line3"";
        }
    }
}
");

        Assert.Contains("(i + 1).ToString()", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void MultilineInterpolation_UnaryHole_ParenthesizesReceiver()
    {
        string rendered = Render(@"
namespace Corpus.Issue3638
{
    public class Holder
    {
        public string Source(int i)
        {
            return $""neg {-i}\nline2\nline3"";
        }
    }
}
");

        Assert.Contains("(-i).ToString()", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
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
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.Empty(context.Diagnostics);
        return GSharpPrinter.Print(unit);
    }
}
