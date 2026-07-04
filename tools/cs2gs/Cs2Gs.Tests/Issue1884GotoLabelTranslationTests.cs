// <copyright file="Issue1884GotoLabelTranslationTests.cs" company="GSharp">
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
/// Issue #1884 (ADR-0139): the C#→G# translator maps <c>goto</c>/labels to
/// G#'s general <c>goto</c>/label surface syntax, and lowers <c>goto case</c>
/// / <c>goto default</c> to a plain <c>goto</c> targeting a synthesized label
/// placed at the top of the matching <c>switch</c> arm's translated body
/// (neither re-evaluates the switch subject, matching C# semantics).
/// </summary>
public class Issue1884GotoLabelTranslationTests
{
    [Fact]
    public void LabeledStatement_And_PlainGoto_TranslateToGSharpLabelAndGoto()
    {
        string rendered = Render(@"
namespace Corpus.Issue1884
{
    public class Loop
    {
        public int Retry()
        {
            int a = 0;
        retry:
            a++;
            if (a < 3)
            {
                goto retry;
            }

            return a;
        }
    }
}
");

        Assert.Contains("retry:", rendered, StringComparison.Ordinal);
        Assert.Contains("goto retry", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void GotoCase_LowersToGotoOfSynthesizedLabelAtMatchingArm()
    {
        string rendered = Render(@"
namespace Corpus.Issue1884
{
    public class Switcher
    {
        public string Run(int value)
        {
            string trace = """";
            switch (value)
            {
                case 1:
                    trace += ""one"";
                    goto case 2;
                case 2:
                    trace += ""two"";
                    break;
                default:
                    trace += ""other"";
                    break;
            }

            return trace;
        }
    }
}
");

        // The `goto case 2;` lowers to a `goto` of a synthesized label
        // (`__gotoCase<pos>`) placed at the top of case 2's translated body.
        Assert.Contains("goto __gotoCase", rendered, StringComparison.Ordinal);
        Assert.Contains("__gotoCase", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void GotoDefault_LowersToGotoOfSynthesizedLabelAtDefaultArm()
    {
        string rendered = Render(@"
namespace Corpus.Issue1884
{
    public class Switcher
    {
        public string Run(int value)
        {
            string trace = """";
            switch (value)
            {
                case 7:
                    trace += ""seven"";
                    goto default;
                default:
                    trace += ""other"";
                    break;
            }

            return trace;
        }
    }
}
");

        Assert.Contains("goto __gotoDefault", rendered, StringComparison.Ordinal);
        Assert.Contains("__gotoDefault", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void LabelIdentifier_CollidingWithGSharpKeyword_IsSanitized()
    {
        string rendered = Render(@"
namespace Corpus.Issue1884
{
    public class KeywordLabel
    {
        public int Run()
        {
            int n = 0;
        @goto:
            n++;
            if (n < 2)
            {
                goto @goto;
            }

            return n;
        }
    }
}
");

        // `goto` is a G# reserved word (see GSharpReservedWords), so the C#
        // verbatim label `@goto` must be suffixed to a valid G# identifier at
        // both its declaration and every reference.
        Assert.Contains("goto_:", rendered, StringComparison.Ordinal);
        Assert.Contains("goto goto_", rendered, StringComparison.Ordinal);
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
