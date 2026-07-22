// <copyright file="Issue2704RecordInitializerTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>Issue #2704: record object initializers retain property accessors.</summary>
public sealed class Issue2704RecordInitializerTranslationTests
{
    [Fact]
    public void ExactCliMapBook_RequiredInitMembersRemainProperties()
    {
        const string source = """
            namespace Oahu.Cli.App.Models
            {
                public sealed record LibraryItem
                {
                    public required string Asin { get; init; }
                    public required string Title { get; init; }
                    public string[] Authors { get; init; } = System.Array.Empty<string>();
                    public string[] Narrators { get; init; } = System.Array.Empty<string>();
                }

                public static class CoreLibraryService
                {
                    public static LibraryItem MapBook(string asin, string title) =>
                        new LibraryItem
                        {
                            Asin = asin,
                            Title = title,
                            Authors = new[] { "author" },
                            Narrators = new[] { "narrator" },
                        };
                }
            }
            """;

        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("CoreLibraryService.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string printed = GSharpPrinter.Print(unit);

        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
        Assert.Contains("data class LibraryItem", printed, StringComparison.Ordinal);
        Assert.Contains("prop Asin string {", printed, StringComparison.Ordinal);
        Assert.Contains("prop Title string {", printed, StringComparison.Ordinal);
        Assert.Contains("init;", printed, StringComparison.Ordinal);
        Assert.Contains("private var _authors []string = Array.Empty[string]()", printed, StringComparison.Ordinal);
        Assert.Contains("prop Authors []string {", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("public let Authors", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("data class LibraryItem(Asin", printed, StringComparison.Ordinal);
        Assert.Contains("LibraryItem{Asin: asin, Title: title", printed, StringComparison.Ordinal);

        RoundTripResult roundTrip = GSharpRoundTrip.Validate(printed);
        Assert.True(
            roundTrip.Success,
            string.Join(Environment.NewLine, roundTrip.Errors) + Environment.NewLine + printed);
    }
}
