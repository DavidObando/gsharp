// <copyright file="Adr0172NamedTupleTranslationTests.cs" company="GSharp">
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

/// ADR-0172 Phase C: cs2gs preserves C# tuple element names end-to-end —
/// types print name-first (`(Line int32, Column int32)`), literal labels
/// survive (`(Line: 1, Column: 2)`), and a named element ACCESS stays
/// by-name instead of lowering to `.ItemN` (amending ADR-0115 §B.4).
/// Every translated snippet must re-bind through the real G# compiler, which
/// exercises gsc's own ADR-0172 front end. Witness of discrimination: before
/// Phase C the printed output contained `(int32, int32)` and
/// `.Item1`/`.Item2` for every case below.
open class Adr0172NamedTupleTranslationTests {
    @Fact
    func NamedTupleType_PrintsNameFirst() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class C
    {
        public (int Line, int Column) Find() => (3, 5);
    }
}`)
        Assert.Contains("(Line int32, Column int32)", printed)
        Assert.DoesNotContain("Item1", printed)
    }

    @Fact
    func NamedElementAccess_StaysByName() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class C
    {
        public int Total()
        {
            (string Name, int Price, int Quantity) item = ("x", 2, 3);
            return item.Price * item.Quantity;
        }
    }
}`)
        Assert.Contains("item.Price * item.Quantity", printed)
        Assert.DoesNotContain("Item2", printed)
        Assert.DoesNotContain("Item3", printed)
    }

    @Fact
    func PositionalAccessOnNamedTuple_StaysPositional() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class C
    {
        public int First()
        {
            (int Line, int Column) pos = (3, 5);
            return pos.Item1;
        }
    }
}`)
        Assert.Contains("pos.Item1", printed)
    }

    @Fact
    func LiteralLabels_ArePreserved() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class C
    {
        public (int Count, string Name) Make() => (Count: 3, Name: "three");
    }
}`)
        Assert.Contains("(Count: 3, Name: \"three\")", printed)
    }

    @Fact
    func UnnamedTuples_Unchanged() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class C
    {
        public (int, string) Make() => (1, "x");
        public int First() => Make().Item1;
    }
}`)
        Assert.Contains("(int32, string)", printed)
        Assert.Contains(".Item1", printed)
    }

    @Fact
    func NamedTupleInsideGeneric_PrintsNames() {
        let printed = TranslateUnit(`
using System.Collections.Generic;

namespace Demo
{
    public sealed class C
    {
        public List<(int Line, int Column)> All() => new List<(int Line, int Column)>();
        public int FirstLine() => All()[0].Line;
    }
}`)
        Assert.Contains("List[(Line int32, Column int32)]", printed)
        Assert.Contains(".Line", printed)
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
