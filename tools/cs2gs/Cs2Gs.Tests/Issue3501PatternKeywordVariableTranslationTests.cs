// <copyright file="Issue3501PatternKeywordVariableTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3501: a C# pattern variable named <c>not</c> (legal in C#, e.g.
/// <c>NotPattern not =&gt;</c>) collides with G#'s negated-pattern keyword in
/// case-pattern position, so the sanitizer must suffix it like the other
/// contextual pattern spellings (<c>and</c>, <c>or</c>, <c>when</c>).
/// </summary>
public class Issue3501PatternKeywordVariableTranslationTests
{
    [Fact]
    public void PatternVariableNamedNot_IsSuffixed_AndRoundTrips()
    {
        string printed = Translate("""
            namespace Demo
            {
                public abstract class Pat { }
                public sealed class Neg : Pat
                {
                    public Pat? Inner { get; init; }
                }

                public static class C
                {
                    public static string Render(Pat p) =>
                        p switch
                        {
                            Neg not => not.Inner is null ? "not ?" : "not x",
                            _ => "other",
                        };
                }
            }
            """);

        Assert.Contains("not_ is Neg", printed, StringComparison.Ordinal);
        Assert.Contains("not_.Inner", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("case not is", printed, StringComparison.Ordinal);
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        string rendered = GSharpPrinter.Print(
            new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity != TranslationSeverity.Info);
        TranslationTestValidation.AssertBinds(rendered);
        return rendered;
    }
}
