// <copyright file="Issue2661ExpressionTreeNullableTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

class Issue2661ExpressionTreeNullableTranslationTests {
    /// Issue #2661's Oahu `BookLibrary` shape. The nullable VALUE-type reads
    /// keep their expression-tree spellings (`!= nil`, `.Value`), since a
    /// `!!` that strips `Nullable<T>` is a real conversion gsc cannot
    /// represent in a tree (GS0473). The stated-`T?` REFERENCE receiver
    /// `b.Conversion` takes `!!` exactly as it does outside a tree
    /// (issue #4356): gsc erases a reference-type assertion there (issue #3349),
    /// and without it the read bound only through gsc's old member-lookup
    /// carve-out for stated-nullable chains.
    @Fact
    func OahuBookLibrary_QueryableLambdas_AssertOnlyTheReferenceReceiver() {
        let printed = Translate(`using System;
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
}`, "The in-memory round-trip binder resolves this IQueryable chain's result as IEnumerable (an overload question unrelated to nullability); the pipeline test compiles the same shape through the SDK.")
        Assert.Contains("b.PurchaseDate != nil", printed, StringComparison.Ordinal)
        Assert.Contains(".Select((b Book) -> b.PurchaseDate.Value)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("b.PurchaseDate!!", printed, StringComparison.Ordinal)
        Assert.Contains("b.Conversion!!.AccountId", printed, StringComparison.Ordinal)
        Assert.Contains("b.Conversion!!.Region", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("GS0473", printed, StringComparison.Ordinal)
    }

    @Fact
    func OrdinaryDelegate_NullableReceiversAndValue_KeepRuntimeAssertions() {
        let printed = Translate(`#nullable enable
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
}`)
        Assert.Contains("book.Conversion!!.AccountId", printed, StringComparison.Ordinal)
        Assert.Contains("book.Conversion!!.Region", printed, StringComparison.Ordinal)
        Assert.Contains("book.PurchaseDate!!", printed, StringComparison.Ordinal)
    }

    shared {
        private func Translate(source string, roundTripOnlyReason string? = nil) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("BookLibrary.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let translated = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(translated)
            let roundTrip = if roundTripOnlyReason == nil {
                TranslationTestValidation.AssertBinds(printed)!!
            } else {
                TranslationTestValidation.ValidateRoundTripOnly(printed, roundTripOnlyReason)
            }
            Assert.True(
                roundTrip.Success,
                "Translated G# must round-trip:\n" + string.Join(Environment.NewLine, roundTrip.Errors) + `

` + printed
            )
            return printed
        }
    }
}
