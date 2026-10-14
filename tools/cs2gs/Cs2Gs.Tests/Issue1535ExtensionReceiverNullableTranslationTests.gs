// <copyright file="Issue1535ExtensionReceiverNullableTranslationTests.cs" company="GSharp">
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

/// Translator-fidelity tests for issue #1535: a C# extension method translates to
/// the receiver-clause form (`func (self T) Name()`). In nullable-oblivious
/// sources the receiver is frequently null-compared in the body (`this object o
/// => o == null`), which — like any ordinary parameter (issue #1072) — makes
/// the receiver truly nullable. The receiver-clause path bypasses
/// `MapParameters`, so its nullability promotion must be applied where the
/// `Receiver` is built; otherwise gsc rejects the guard with `GS0129`.
/// The negative test pins the precision guard: a receiver that is never
/// null-checked keeps its non-nullable type.
open class Issue1535ExtensionReceiverNullableTranslationTests {
    @Fact
    func NullComparedObjectReceiver_RendersNullableReceiver() {
        let printed = TranslateUnit(`
namespace Demo
{
    public static class Ext
    {
        public static bool IsNull(this object o) => o == null;
    }
}`)
        Assert.Contains("func (o object?) IsNull()", printed)
    }

    @Fact
    func NullComparedGenericSequenceReceiver_RendersNullableReceiver() {
        let printed = TranslateUnit(`
namespace Demo
{
    using System.Collections.Generic;
    using System.Linq;

    public static class Ext
    {
        public static bool IsNullOrEmpty<T>(this IEnumerable<T> e) => e == null || !e.Any();
    }
}`)
        Assert.Contains("func (e IEnumerable[T]?) IsNullOrEmpty[T]()", printed)
    }

    @Fact
    func NullComparedArrayReceiver_RendersNullableReceiver() {
        let printed = TranslateUnit(`
namespace Demo
{
    public static class Ext
    {
        public static bool StartsBad(this byte[] bytes) => bytes == null || bytes.Length < 8;
    }
}`)
        Assert.Contains("func (bytes []?uint8) StartsBad()", printed)
    }

    @Fact
    func NonNullCheckedReceiver_KeepsNonNullableReceiver() {
        // Precision guard: a receiver that is never null-compared nor null-assigned
        // must NOT be promoted — its type clause stays non-nullable.
        let printed = TranslateUnit(`
namespace Demo
{
    public static class Ext
    {
        public static int Twice(this int n) => n + n;
        public static int Len(this string s) => s.Length;
    }
}`)
        Assert.Contains("func (s string) Len()", printed)
        Assert.DoesNotContain("string?", printed)
    }

    shared {
        private func TranslateUnit(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }
    }
}
