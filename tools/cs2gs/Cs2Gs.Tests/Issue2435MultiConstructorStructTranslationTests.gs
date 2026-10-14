// <copyright file="Issue2435MultiConstructorStructTranslationTests.cs" company="GSharp">
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

open class Issue2435MultiConstructorStructTranslationTests {
    @Fact
    func StructWithNoDeclaredConstructor_AndCallSite_IsPreserved() {
        let (printed, context) = Translate(`
namespace Demo
{
    public struct Counter
    {
        public int Value;
        public int Double() => Value * 2;
    }

    public class Use
    {
        public Counter Make() => new Counter();
    }
}`)
        Assert.Contains("struct Counter", printed, StringComparison.Ordinal)
        Assert.Contains("Counter{}", printed, StringComparison.Ordinal)
        Assert.Contains("Double", printed, StringComparison.Ordinal)
        AssertNoUnsupported(context)
        AssertRoundTrips(printed)
    }

    @Fact
    func StructWithOneConstructor_PreservesInitAndCall() {
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
    }

    public class Use
    {
        public Point Make() => new Point(1, 2);
    }
}`)
        Assert.Contains("struct Point", printed, StringComparison.Ordinal)
        Assert.Contains("init(x int32, y int32)", printed, StringComparison.Ordinal)
        Assert.Contains("Point(1, 2)", printed, StringComparison.Ordinal)
        AssertNoUnsupported(context)
        AssertRoundTrips(printed)
    }

    @Fact
    func SingleConstructorFixedAssignment_StaysInInit() {
        let (printed, context) = Translate(`
namespace Demo
{
    public struct Point
    {
        public int X;
        public int Y;

        public Point(int x)
        {
            X = x;
            Y = 7;
        }
    }

    public class Use
    {
        public Point Make() => new Point(1);
    }
}`)
        Assert.Contains("init(x int32)", printed, StringComparison.Ordinal)
        Assert.Contains("Y = 7", printed, StringComparison.Ordinal)
        Assert.Contains("Point(1)", printed, StringComparison.Ordinal)
        AssertNoUnsupported(context)
        AssertRoundTrips(printed)
    }

    @Fact
    func StructWithMultipleRepresentableConstructors_PreservesOverloadsAndCalls() {
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

        public Point(int x)
        {
            X = x;
            Y = 0;
        }
    }

    public class Use
    {
        public Point Pair() => new Point(1, 2);
        public Point Single() => new Point(3);
    }
}`)
        Assert.Contains("struct Point", printed, StringComparison.Ordinal)
        Assert.Contains("init(x int32, y int32)", printed, StringComparison.Ordinal)
        Assert.Contains("init(x int32)", printed, StringComparison.Ordinal)
        Assert.Contains("Point(1, 2)", printed, StringComparison.Ordinal)
        Assert.Contains("Point(3)", printed, StringComparison.Ordinal)
        AssertNoUnsupported(context)
        AssertRoundTrips(printed)
    }

    @Fact
    func DelegatingParameterlessConstructor_PreservesConvenienceInit() {
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

        public Point() : this(0, 0)
        {
        }
    }

    public class Use
    {
        public Point Origin() => new Point();
        public Point Other() => new Point(4, 5);
    }
}`)
        Assert.Contains("struct Point", printed, StringComparison.Ordinal)
        Assert.Contains("convenience init()", printed, StringComparison.Ordinal)
        Assert.Contains("init(0, 0)", printed, StringComparison.Ordinal)
        Assert.Contains("Point()", printed, StringComparison.Ordinal)
        Assert.Contains("Point(4, 5)", printed, StringComparison.Ordinal)
        AssertNoUnsupported(context)
        AssertRoundTrips(printed)
    }

    @Fact
    func ConstructorCall_ComposesWithDistinctObjectInitializerMembers() {
        let (printed, context) = Translate(`
namespace Demo
{
    public struct Reading
    {
        public int Value { get; }
        public string Label { get; set; }

        public Reading(int value)
        {
            Value = value;
        }

        public bool IsPositive() => Value > 0;
    }

    public class Use
    {
        public Reading Make() => new Reading(3) { Label = "ok" };
    }
}`)
        Assert.Contains("struct Reading", printed, StringComparison.Ordinal)
        Assert.Contains("Reading(3)", printed, StringComparison.Ordinal)
        Assert.Contains("Label = \"ok\"", printed, StringComparison.Ordinal)
        Assert.Contains("IsPositive", printed, StringComparison.Ordinal)
        AssertNoUnsupported(context)
        AssertRoundTrips(printed)
    }

    @Fact
    func ConstructorWithLogic_IsPreservedEvenWithoutCallSite() {
        let (printed, context) = Translate(`
namespace Demo
{
    public struct Validated
    {
        public int Value;

        public Validated(int value)
        {
            if (value < 0)
            {
                throw new System.ArgumentOutOfRangeException(nameof(value));
            }

            Value = value;
        }

        public Validated(string text)
        {
            Value = int.Parse(text);
        }
    }
}`)
        Assert.Contains("struct Validated", printed, StringComparison.Ordinal)
        Assert.Contains("init(value int32)", printed, StringComparison.Ordinal)
        Assert.Contains("init(text string)", printed, StringComparison.Ordinal)
        AssertNoUnsupported(context)
        AssertRoundTrips(printed)
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
            return (GSharpPrinter.Print(unit), context)
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
