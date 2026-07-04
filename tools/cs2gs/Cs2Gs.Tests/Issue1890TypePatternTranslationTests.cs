// <copyright file="Issue1890TypePatternTranslationTests.cs" company="GSharp">
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
/// Issue #1890: a bare-type C# switch-arm pattern (<c>int =&gt;</c>, no
/// binder — Roslyn's <c>TypePatternSyntax</c>) had no canonical G# form and
/// reported the CS2GS-GAP "pattern 'TypePattern' has no canonical G# form
/// yet". G#'s own <c>TypePattern</c> grammar always requires a designator
/// before <c>is</c>, but treats <c>_</c> as a real discard there
/// (<c>PatternBinder.BindTypePattern</c>'s <c>isDiscard</c> check), so the
/// bare arm lowers to <c>_ is T</c> with no binding introduced.
/// </summary>
public class Issue1890TypePatternTranslationTests
{
    [Fact]
    public void SwitchExpression_BareTypeArms_LowerToDiscardTypePatterns()
    {
        string rendered = Render(@"
namespace Corpus.Issue1890
{
    public class Widget
    {
    }

    public class Holder
    {
        public string Describe(object mystery) => mystery switch
        {
            int => ""int"",
            Widget => ""widget"",
            _ => ""other"",
        };
    }
}
");

        Assert.Contains("case _ is int32:", rendered, StringComparison.Ordinal);
        Assert.Contains("case _ is Widget:", rendered, StringComparison.Ordinal);
        Assert.Contains("default:", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void SwitchStatement_BareTypeArm_LowersToDiscardTypePattern()
    {
        string rendered = Render(@"
namespace Corpus.Issue1890
{
    public class Holder
    {
        public string Describe(object mystery)
        {
            switch (mystery)
            {
                case string:
                    return ""string"";
                default:
                    return ""other"";
            }
        }
    }
}
");

        Assert.Contains("case _ is string {", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void SwitchExpression_BareTypeArmInsideOrCombinator_LowersToDiscardTypePattern()
    {
        string rendered = Render(@"
namespace Corpus.Issue1890
{
    public class Holder
    {
        public string Describe(object mystery) => mystery switch
        {
            int or long => ""whole number"",
            _ => ""other"",
        };
    }
}
");

        Assert.Contains("case _ is int32 or _ is int64:", rendered, StringComparison.Ordinal);
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
