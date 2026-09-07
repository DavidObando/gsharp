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
/// Issue #3638: multiline interpolation must keep non-atomic holes intact.
/// Issue #3948 now keeps every hole inside a quoted interpolation fragment
/// instead of appending a synthetic <c>.ToString()</c>, preserving both the
/// original precedence and interpolation semantics.
/// </summary>
public class Issue3638InterpolationEscapedQuoteTests
{
    [Fact]
    public void MultilineInterpolation_EscapedQuotesAndExpressionHole_StaysInterpolatedAndRoundTrips()
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

        Assert.Contains("\"${i + 1}\"", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("ToString()", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void MultilineInterpolation_PlainIdentifierHole_UsesShorthand()
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

        Assert.Contains("\"$i\"", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("ToString()", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void MultilineVerbatimInterpolation_EscapedQuotesAndExpressionHole_StaysInterpolatedAndRoundTrips()
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

        Assert.Contains("\"${i + 1}\"", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void MultilineInterpolation_UnaryHole_StaysInterpolated()
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

        Assert.Contains("\"${-i}\"", rendered, StringComparison.Ordinal);
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
