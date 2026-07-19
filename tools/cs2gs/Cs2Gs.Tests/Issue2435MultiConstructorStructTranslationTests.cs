// <copyright file="Issue2435MultiConstructorStructTranslationTests.cs" company="GSharp">
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

public class Issue2435MultiConstructorStructTranslationTests
{
    [Fact]
    public void StructWithNoDeclaredConstructor_AndCallSite_IsPreserved()
    {
        (string printed, TranslationContext context) = Translate(@"
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
}");

        Assert.Contains("struct Counter", printed, StringComparison.Ordinal);
        Assert.Contains("Counter{}", printed, StringComparison.Ordinal);
        Assert.Contains("Double", printed, StringComparison.Ordinal);
        AssertNoUnsupported(context);
        AssertRoundTrips(printed);
    }

    [Fact]
    public void StructWithOneConstructor_LiftsAndCallSiteUsesLiteral()
    {
        (string printed, TranslationContext context) = Translate(@"
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
}");

        Assert.Contains("struct Point", printed, StringComparison.Ordinal);
        Assert.Contains("Point{X: 1, Y: 2}", printed, StringComparison.Ordinal);
        AssertNoUnsupported(context);
        AssertRoundTrips(printed);
    }

    [Fact]
    public void SingleConstructorFixedAssignment_UsesLiftedFieldInitializerOnce()
    {
        (string printed, TranslationContext context) = Translate(@"
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
}");

        Assert.Contains("Point{X: 1}", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("Point{X: 1, Y: 7}", printed, StringComparison.Ordinal);
        AssertNoUnsupported(context);
        AssertRoundTrips(printed);
    }

    [Fact]
    public void StructWithMultipleRepresentableConstructors_IsPreservedAndOverloadsLowerAtCallSites()
    {
        (string printed, TranslationContext context) = Translate(@"
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
}");

        Assert.Contains("struct Point", printed, StringComparison.Ordinal);
        Assert.Contains("Point{X: 1, Y: 2}", printed, StringComparison.Ordinal);
        Assert.Contains("Point{X: 3, Y: 0}", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("init(", printed, StringComparison.Ordinal);
        AssertNoUnsupported(context);
        AssertRoundTrips(printed);
    }

    [Fact]
    public void DelegatingParameterlessConstructor_LowersThroughDesignatedConstructor()
    {
        (string printed, TranslationContext context) = Translate(@"
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
}");

        Assert.Contains("struct Point", printed, StringComparison.Ordinal);
        Assert.Contains("Point{X: 0, Y: 0}", printed, StringComparison.Ordinal);
        Assert.Contains("Point{X: 4, Y: 5}", printed, StringComparison.Ordinal);
        AssertNoUnsupported(context);
        AssertRoundTrips(printed);
    }

    [Fact]
    public void ConstructorLiteral_ComposesWithDistinctObjectInitializerMembers()
    {
        (string printed, TranslationContext context) = Translate(@"
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
        public Reading Make() => new Reading(3) { Label = ""ok"" };
    }
}");

        Assert.Contains("struct Reading", printed, StringComparison.Ordinal);
        Assert.Contains("Reading{Value: 3, Label: \"ok\"}", printed, StringComparison.Ordinal);
        Assert.Contains("IsPositive", printed, StringComparison.Ordinal);
        AssertNoUnsupported(context);
        AssertRoundTrips(printed);
    }

    [Fact]
    public void UnsupportedConstructorShape_IsDiagnosedEvenWithoutCallSite()
    {
        (string printed, TranslationContext context) = Translate(@"
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
}");

        Assert.DoesNotContain("struct Validated", printed, StringComparison.Ordinal);
        Assert.Contains(
            context.Diagnostics,
            diagnostic =>
                diagnostic.Severity == TranslationSeverity.Unsupported &&
                diagnostic.Message.Contains("Validated", StringComparison.Ordinal) &&
                diagnostic.Message.Contains("#2435", StringComparison.Ordinal));
    }

    private static (string Printed, TranslationContext Context) Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return (GSharpPrinter.Print(unit), context);
    }

    private static void AssertNoUnsupported(TranslationContext context)
    {
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
    }

    private static void AssertRoundTrips(string printed)
    {
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
    }
}
