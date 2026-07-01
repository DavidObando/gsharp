// <copyright file="Issue1535ExtensionReceiverNullableTranslationTests.cs" company="GSharp">
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
/// Translator-fidelity tests for issue #1535: a C# extension method translates to
/// the receiver-clause form (<c>func (self T) Name()</c>). In nullable-oblivious
/// sources the receiver is frequently null-compared in the body (<c>this object o
/// =&gt; o == null</c>), which — like any ordinary parameter (issue #1072) — makes
/// the receiver truly nullable. The receiver-clause path bypasses
/// <c>MapParameters</c>, so its nullability promotion must be applied where the
/// <c>Receiver</c> is built; otherwise gsc rejects the guard with <c>GS0129</c>.
/// The negative test pins the precision guard: a receiver that is never
/// null-checked keeps its non-nullable type.
/// </summary>
public class Issue1535ExtensionReceiverNullableTranslationTests
{
    [Fact]
    public void NullComparedObjectReceiver_RendersNullableReceiver()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class Ext
    {
        public static bool IsNull(this object o) => o == null;
    }
}");

        Assert.Contains("func (o object?) IsNull()", printed);
    }

    [Fact]
    public void NullComparedGenericSequenceReceiver_RendersNullableReceiver()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    using System.Collections.Generic;
    using System.Linq;

    public static class Ext
    {
        public static bool IsNullOrEmpty<T>(this IEnumerable<T> e) => e == null || !e.Any();
    }
}");

        Assert.Contains("func (e IEnumerable[T]?) IsNullOrEmpty[T]()", printed);
    }

    [Fact]
    public void NullComparedArrayReceiver_RendersNullableReceiver()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class Ext
    {
        public static bool StartsBad(this byte[] bytes) => bytes == null || bytes.Length < 8;
    }
}");

        Assert.Contains("func (bytes []?uint8) StartsBad()", printed);
    }

    [Fact]
    public void NonNullCheckedReceiver_KeepsNonNullableReceiver()
    {
        // Precision guard: a receiver that is never null-compared nor null-assigned
        // must NOT be promoted — its type clause stays non-nullable.
        string printed = TranslateUnit(@"
namespace Demo
{
    public static class Ext
    {
        public static int Twice(this int n) => n + n;
        public static int Len(this string s) => s.Length;
    }
}");

        Assert.Contains("func (s string) Len()", printed);
        Assert.DoesNotContain("string?", printed);
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
