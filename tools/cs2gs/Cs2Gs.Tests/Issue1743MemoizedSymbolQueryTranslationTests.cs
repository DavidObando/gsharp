// <copyright file="Issue1743MemoizedSymbolQueryTranslationTests.cs" company="GSharp">
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
/// Translator-fidelity + memoization tests for issue #1743: <c>IsUsedAsNullable</c>
/// and <c>IsSymbolReassigned</c> each re-walked their whole scope (containing type
/// / enclosing body) on EVERY call for the same symbol, an O(accesses × type size)
/// cost in a nullable-oblivious corpus (every field/property receiver access
/// triggers the walk). Both are now memoized per (symbol, scope) on the
/// translator instance. These tests pin that the memoized answer is unchanged
/// from the un-memoized one (a field that IS used as nullable still gets its
/// <c>!!</c> forgiveness / <c>T?</c> type, one that is NOT still doesn't; a
/// reassigned local still renders <c>var</c>, a never-reassigned one still
/// renders <c>let</c>) and that repeatedly querying the same symbol answers
/// identically every time (whether served from a fresh walk or the memoized
/// cache).
/// </summary>
public class Issue1743MemoizedSymbolQueryTranslationTests
{
    [Fact]
    public void FieldUsedAsNullable_StillGetsNullForgiveness()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        private string name;
        private string other;

        public void F()
        {
            if (this.name == null) { }
            System.Console.WriteLine(this.name.Length);
            System.Console.WriteLine(this.other.Length);
        }
    }
}");

        // `name` is null-checked elsewhere in the type, so its every receiver
        // use gets the flow-independent `!!` forgiveness (issue #1072).
        Assert.Contains("name!!.Length", printed);

        // `other` is never compared/assigned to null anywhere in the type, so
        // it stays a bare (non-promoted) receiver.
        Assert.DoesNotContain("other!!.Length", printed);
    }

    [Fact]
    public void ReassignedLocal_StillRendersVar_NonReassignedLocal_StillRendersLet()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public void F()
        {
            int x = 1;
            x = 2;
            int y = 1;
            System.Console.WriteLine(x + y);
        }
    }
}");

        Assert.Contains("var x = 1", printed);
        Assert.DoesNotContain("let x", printed);

        Assert.Contains("let y = 1", printed);
        Assert.DoesNotContain("var y", printed);
    }

    [Fact]
    public void RepeatedReceiverAndReassignmentQueries_AreIdempotent()
    {
        // Same symbol (`this.name` field, local `x`) queried many times over —
        // each call must answer identically to every other call for that
        // symbol, whether served from a fresh walk or the memoized cache
        // (issue #1743).
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        private string name;

        public void F()
        {
            if (this.name == null) { }
            System.Console.WriteLine(this.name.Length);
            System.Console.WriteLine(this.name.Length);
            System.Console.WriteLine(this.name.Length);
            int x = 1;
            x = 2;
            x = 3;
            System.Console.WriteLine(x);
        }
    }
}");

        int nameForgivenessCount = CountOccurrences(printed, "name!!.Length");
        Assert.Equal(3, nameForgivenessCount);

        Assert.Contains("var x = 1", printed);
        Assert.DoesNotContain("let x", printed);
    }

    private static int CountOccurrences(string text, string value)
    {
        int count = 0;
        int index = 0;
        while ((index = text.IndexOf(value, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += value.Length;
        }

        return count;
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

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
