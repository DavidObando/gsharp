// <copyright file="Issue2661ExpressionTreeNullableTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable
using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue2661ExpressionTreeNullableTranslationTests
{
    [Fact]
    public void OahuBookLibrary_QueryableLambdas_OmitThreeRuntimeAssertions()
    {
        string printed = Translate("""
            using System;
            using System.Linq;

            namespace Oahu.Core;

            public sealed class Conversion
            {
                public string AccountId { get; set; }
                public string Region { get; set; }
            }

            public sealed class Book
            {
                public DateTime? PurchaseDate { get; set; }
                public Conversion? Conversion { get; set; }
            }

            public static class BookLibrary
            {
                public static IQueryable<DateTime> SinceLatestPurchaseDate(
                    IQueryable<Book> books,
                    Conversion profileId) =>
                    books
                        .Where(b => b.PurchaseDate.HasValue &&
                            b.Conversion.AccountId == profileId.AccountId &&
                            b.Conversion.Region == profileId.Region)
                        .Select(b => b.PurchaseDate.Value);
            }
            """);

        Assert.Contains("b.PurchaseDate != nil", printed, StringComparison.Ordinal);
        Assert.Contains(".Select((b Book) -> b.PurchaseDate.Value)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("b.PurchaseDate!!", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("b.Conversion!!", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("GS0473", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void OrdinaryDelegate_NullableReceiversAndValue_KeepRuntimeAssertions()
    {
        string printed = Translate("""
            #nullable enable
            using System;

            namespace Oahu.Core;

            public sealed class Conversion
            {
                public string AccountId { get; set; }
                public string Region { get; set; }
            }

            public sealed class Book
            {
                public DateTime? PurchaseDate { get; set; }
                public Conversion? Conversion { get; set; }
            }

            public static class BookLibrary
            {
                public static Func<Book, bool> Matches(Conversion profileId) =>
                    book => book.PurchaseDate.HasValue &&
                        book.Conversion.AccountId == profileId.AccountId &&
                        book.Conversion.Region == profileId.Region;

                public static Func<Book, DateTime> Purchased() =>
                    book => book.PurchaseDate.Value;
            }
            """);

        Assert.Contains("book.Conversion!!.AccountId", printed, StringComparison.Ordinal);
        Assert.Contains("book.Conversion!!.Region", printed, StringComparison.Ordinal);
        Assert.Contains("book.PurchaseDate!!", printed, StringComparison.Ordinal);
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("BookLibrary.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind: " + string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit translated = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string printed = GSharpPrinter.Print(translated);
        RoundTripResult roundTrip = GSharpRoundTrip.Validate(printed);
        Assert.True(
            roundTrip.Success,
            "Translated G# must round-trip:\n" +
                string.Join(Environment.NewLine, roundTrip.Errors) +
                "\n\n" + printed);
        return printed;
    }
}
