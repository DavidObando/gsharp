// <copyright file="Issue1990MultiCtorStructUnsupportedTests.cs" company="GSharp">
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
/// Issues #1990/#2435 originally rejected plain-struct constructors that could
/// not be replayed as literals. Issue #2766 gives plain structs a real
/// <c>init</c> surface, so those shapes now preserve their constructor bodies;
/// record structs retain their separate data-struct lowering.
/// </summary>
public class Issue1990MultiCtorStructUnsupportedTests
{
    [Fact]
    public void MultiCtorStruct_PreservesExplicitOverloads()
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

        public Point(int both)
        {
            X = both;
            Y = both;
        }
    }
}");

        Assert.Contains("struct Point", printed);
        Assert.Contains("init(x int32, y int32)", printed);
        Assert.Contains("init(both int32)", printed);
        AssertNoUnsupported(context);
        AssertRoundTrips(printed);
    }

    [Fact]
    public void SingleUnliftableCtorStruct_PreservesBody()
    {
        // The ctor's RHS reads instance state, so it cannot become a field
        // initializer or primary-constructor parameter. It now stays in `init`.
        (string printed, TranslationContext context) = Translate(@"
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
}");

        Assert.Contains("struct Ring", printed);
        Assert.Contains("init(capacity int32)", printed);
        AssertNoUnsupported(context);
        AssertRoundTrips(printed);
    }

    [Fact]
    public void RecordStruct_MultiCtor_ReportsUnsupported_AndDropsType()
    {
        (string printed, TranslationContext context) = Translate(@"
namespace Demo
{
    public readonly record struct Coord(int X, int Y)
    {
        public Coord(int both) : this(both, both) { }
    }
}");

        Assert.DoesNotContain("data class Coord", printed);
        Assert.DoesNotContain("data struct Coord", printed);
        Assert.Contains(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported &&
                d.Message.Contains("Coord", StringComparison.Ordinal));
    }

    [Fact]
    public void MultiCtorStruct_AndSiblingMembersBothEmitAndRoundTrip()
    {
        // Dropping the unsupported type must not take down the rest of the
        // file: an unrelated sibling class still translates and the printed
        // output — minus the dropped type — still round-trip parses.
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
}");

        Assert.Contains("class Unrelated", printed);
        Assert.Contains("struct Point", printed);

        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# (with the unsupported type dropped) must still round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);

        AssertNoUnsupported(context);
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

        string printed = GSharpPrinter.Print(unit);
        return (printed, context);
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
