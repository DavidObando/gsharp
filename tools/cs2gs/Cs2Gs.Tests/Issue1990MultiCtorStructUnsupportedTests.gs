// <copyright file="Issue1990MultiCtorStructUnsupportedTests.cs" company="GSharp">
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

/// Issues #1990/#2435 originally rejected plain-struct constructors that could
/// not be replayed as literals. Issue #2766 gives plain structs a real
/// `init` surface, so those shapes now preserve their constructor bodies;
/// record structs retain their separate data-struct lowering.
open class Issue1990MultiCtorStructUnsupportedTests {
    @Fact
    func MultiCtorStruct_PreservesExplicitOverloads() {
        let (printed, context) = Translate(`
namespace Demo
{
    public struct Point
    {
        public int X;
        public int Y;

        public Point(int x, int y)
        {
            X = x;
            Y = y;
        }

        public Point(int both)
        {
            X = both;
            Y = both;
        }
    }
}`)
        Assert.Contains("struct Point", printed)
        Assert.Contains("init(x int32, y int32)", printed)
        Assert.Contains("init(both int32)", printed)
        AssertNoUnsupported(context)
        AssertRoundTrips(printed)
    }

    @Fact
    func SingleUnliftableCtorStruct_PreservesBody() {
        // The ctor's RHS reads instance state, so it cannot become a field
        // initializer or primary-constructor parameter. It now stays in `init`.
        let (printed, context) = Translate(`
namespace Demo
{
    public struct Ring
    {
        public int Capacity;
        public int[] Buffer;

        public Ring(int capacity)
        {
            Capacity = capacity;
            Buffer = new int[Capacity];
        }
    }
}`)
        Assert.Contains("struct Ring", printed)
        Assert.Contains("init(capacity int32)", printed)
        AssertNoUnsupported(context)
        AssertRoundTrips(printed)
    }

    @Fact
    func RecordStruct_MultiCtor_ReportsUnsupported_AndDropsType() {
        let (printed, context) = Translate(`
namespace Demo
{
    public readonly record struct Coord(int X, int Y)
    {
        public Coord(int both) : this(both, both) { }
    }
}`)
        Assert.DoesNotContain("data class Coord", printed)
        Assert.DoesNotContain("data struct Coord", printed)
        Assert.Contains(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported && d.Message!!.Contains(
                "Coord",
                StringComparison.Ordinal
            )
        )
    }

    @Fact
    func MultiCtorStruct_AndSiblingMembersBothEmitAndRoundTrip() {
        // Dropping the unsupported type must not take down the rest of the
        // file: an unrelated sibling class still translates and the printed
        // output — minus the dropped type — still round-trip parses.
        let (printed, context) = Translate(`
namespace Demo
{
    public struct Point
    {
        public int X;
        public int Y;

        public Point(int x, int y)
        {
            X = x;
            Y = y;
        }

        public Point(int both)
        {
            X = both;
            Y = both;
        }
    }

    public class Unrelated
    {
        public int Value;
    }
}`)
        Assert.Contains("class Unrelated", printed)
        Assert.Contains("struct Point", printed)
        let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
        Assert.True(
            result!!.Success,
            "Translated G# (with the unsupported type dropped) must still round-trip. Errors:\n" + string.Join(
                "\n",
                result!!.Errors
            ) +
                `

Printed:
` +
                printed
        )
        AssertNoUnsupported(context)
    }

    shared {
        private func Translate(source string)(Printed string, Context TranslationContext) {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            return (printed, context)
        }

        private func AssertNoUnsupported(context TranslationContext) {
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
        }

        private func AssertRoundTrips(printed string) {
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
        }
    }
}
