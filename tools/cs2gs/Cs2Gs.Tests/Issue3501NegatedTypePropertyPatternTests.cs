// <copyright file="Issue3501NegatedTypePropertyPatternTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3501 (GS0172/GS0173 family): a boolean-position C# `is not
/// T { props }` translates to a G# `not` over an `and`-combined
/// type+property pattern, but `not` binds tighter than `and` in gsc's
/// pattern grammar — printing the combinator child bare re-associated to
/// `(not T) and { props }`, so the property pattern escaped the negation and
/// was checked against the scrutinee's own (possibly nullable) type. The
/// printer now parenthesizes a combinator child of `not`.
/// </summary>
public class Issue3501NegatedTypePropertyPatternTests
{
    [Fact]
    public void NegatedTypeWithPropertyPattern_KeepsGroupingUnderNot()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class Node
    {
        public Node Inner { get; set; }
        public int Rank { get; set; }
    }

    public static class Probe
    {
        public static bool Reject(object value)
        {
            if (value is not Node { Rank: 3 })
            {
                return true;
            }

            return false;
        }
    }
}");

        Assert.DoesNotContain("not Node and {", printed, StringComparison.Ordinal);
        Assert.True(
            printed.Contains("not (Node and { Rank: 3 })", StringComparison.Ordinal)
                || printed.Contains("not Node { Rank: 3 }", StringComparison.Ordinal)
                || printed.Contains("!(value is Node", StringComparison.Ordinal),
            "The negation must cover the whole type+property pattern. Printed:\n" + printed);
    }

    private static string TranslateUnit(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
