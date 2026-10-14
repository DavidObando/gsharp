// <copyright file="Issue1743MemoizedSymbolQueryTranslationTests.cs" company="GSharp">
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

/// Translator-fidelity + memoization tests for issue #1743: `IsUsedAsNullable`
/// and `IsSymbolReassigned` each re-walked their whole scope (containing type
/// / enclosing body) on EVERY call for the same symbol, an O(accesses × type size)
/// cost in a nullable-oblivious corpus (every field/property receiver access
/// triggers the walk). Both are now memoized per (symbol, scope) on the
/// translator instance. These tests pin that the memoized answer is unchanged
/// from the un-memoized one (a field that IS used as nullable still gets its
/// `!!` forgiveness / `T?` type, one that is NOT still doesn't; a
/// reassigned local still renders `var`, a never-reassigned one still
/// renders `let`) and that repeatedly querying the same symbol answers
/// identically every time (whether served from a fresh walk or the memoized
/// cache).
open class Issue1743MemoizedSymbolQueryTranslationTests {
    @Fact
    func FieldUsedAsNullable_StillGetsNullForgiveness() {
        let printed = TranslateUnit(`
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
}`)
        // `name` is null-checked elsewhere in the type, so its every receiver
        // use gets the flow-independent `!!` forgiveness (issue #1072).
        Assert.Contains("name!!.Length", printed)
        // `other` is never compared/assigned to null anywhere in the type, so
        // it stays a bare (non-promoted) receiver.
        Assert.DoesNotContain("other!!.Length", printed)
    }

    @Fact
    func ReassignedLocal_StillRendersVar_NonReassignedLocal_StillRendersLet() {
        let printed = TranslateUnit(`
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
}`)
        Assert.Contains("var x = 1", printed)
        Assert.DoesNotContain("let x", printed)
        Assert.Contains("let y = 1", printed)
        Assert.DoesNotContain("var y", printed)
    }

    @Fact
    func RepeatedReceiverAndReassignmentQueries_AreIdempotent() {
        // Same symbol (`this.name` field, local `x`) queried many times over —
        // each call must answer identically to every other call for that
        // symbol, whether served from a fresh walk or the memoized cache
        // (issue #1743).
        let printed = TranslateUnit(`
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
}`)
        let nameForgivenessCount = CountOccurrences(printed, "name!!.Length")
        Assert.Equal(3, nameForgivenessCount)
        Assert.Contains("var x = 1", printed)
        Assert.DoesNotContain("let x", printed)
    }

    shared {
        private func CountOccurrences(text string, value string) int32 {
            var count = 0
            var index = 0
            while (index = text.IndexOf(value, index, StringComparison.Ordinal)) >= 0 {
                count++
                index += value.Length
            }
            return count
        }

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
