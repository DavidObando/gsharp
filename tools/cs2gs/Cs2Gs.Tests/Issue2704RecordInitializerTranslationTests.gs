// <copyright file="Issue2704RecordInitializerTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Linq
import Xunit

/// Issue #2704: record object initializers retain property accessors.
class Issue2704RecordInitializerTranslationTests {
    @Fact
    func ExactCliMapBook_RequiredInitMembersRemainProperties() {
        const source = `namespace Oahu.Cli.App.Models
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
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("CoreLibraryService.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
        let printed = GSharpPrinter.Print(unit)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
        Assert.Contains("data class LibraryItem", printed, StringComparison.Ordinal)
        Assert.Contains("prop Asin string {", printed, StringComparison.Ordinal)
        Assert.Contains("prop Title string {", printed, StringComparison.Ordinal)
        Assert.Contains("init;", printed, StringComparison.Ordinal)
        Assert.Contains("private var _authors []string = Array.Empty[string]()", printed, StringComparison.Ordinal)
        Assert.Contains("prop Authors []string {", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("public let Authors", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("data class LibraryItem(Asin", printed, StringComparison.Ordinal)
        Assert.Contains("LibraryItem{Asin: asin, Title: title", printed, StringComparison.Ordinal)
        let roundTrip RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
        Assert.True(
            roundTrip!!.Success,
            string.Join(Environment.NewLine, roundTrip!!.Errors) + Environment.NewLine + printed
        )
    }
}
