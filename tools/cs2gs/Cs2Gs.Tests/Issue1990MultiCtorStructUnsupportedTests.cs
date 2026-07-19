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
/// Issue #1990: a C# struct with multiple constructors that cannot ALL be
/// lifted to a single G# primary-constructor form used to fall through to
/// <c>TranslateConstructor</c> unconditionally, emitting an explicit
/// <c>init(...)</c> constructor body on the translated <c>struct</c> — but
/// the G# parser only accepts <c>init(...)</c> on a <c>class</c> header
/// (<c>DeclarationBinder.BindConstructors</c> early-returns for a non-class
/// type; ADR-0115 §B.5/§B.14's "no explicit init on a value aggregate" rule
/// is by design), so the translated output failed to parse. The same defect
/// applied to a single-constructor struct whose constructor could not
/// collapse to a primary constructor (e.g. it reads an instance member) and
/// to a C# record struct with a non-positional multi-ctor shape.
///
/// A first fix attempt silently downgraded such a type to a class/data class.
/// That was rejected on review: it flips value semantics to reference
/// semantics — <c>Equals</c>/<c>GetHashCode</c> become reference-identity,
/// <c>default(T)</c> becomes <c>null</c>, copy-on-assign becomes aliasing,
/// storage becomes heap-allocated — which is exactly the kind of silent
/// approximation ADR-0115 §B ("the translator never guesses") forbids. Per
/// ADR-0115's own guidance, a constructor shape that cannot be replayed as a
/// call-site struct literal is reported as a loud <c>Unsupported</c>
/// diagnostic and the type is dropped from the emitted output. Issue #2435
/// later generalized the representable case: multiple simple constructors are
/// preserved by lowering each resolved overload at its call sites, while the
/// non-representable cases below remain explicit gaps.
/// </summary>
public class Issue1990MultiCtorStructUnsupportedTests
{
    [Fact]
    public void MultiCtorStruct_ReportsUnsupported_AndDropsType()
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

        // The one-argument overload consumes `both` twice. Repeating the caller's
        // argument expression in two literal fields could duplicate side effects,
        // so no canonical G# form is invented.
        Assert.DoesNotContain("class Point", printed);
        Assert.DoesNotContain("struct Point", printed);

        Assert.Contains(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported &&
                d.Message.Contains("Point", StringComparison.Ordinal) &&
                d.Message.Contains("no canonical G# form", StringComparison.Ordinal) &&
                d.Message.Contains("Equals", StringComparison.Ordinal) &&
                d.Message.Contains("default(T)", StringComparison.Ordinal));
    }

    [Fact]
    public void SingleUnliftableCtorStruct_ReportsUnsupported_AndDropsType()
    {
        // The ctor's RHS (`Buffer = new int[Capacity]`) reads the instance
        // member `Capacity`, so it cannot become a field initializer or a
        // primary-constructor parameter — the lift bails, and (pre-fix) the
        // explicit ctor was kept and emitted as an invalid struct `init`.
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

        Assert.DoesNotContain("class Ring", printed);
        Assert.DoesNotContain("struct Ring", printed);
        Assert.Contains(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported &&
                d.Message.Contains("Ring", StringComparison.Ordinal));
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
    public void MultiCtorStruct_SiblingMembersStillEmit_AndFileRoundTrips()
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
        Assert.DoesNotContain("Point", printed);

        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# (with the unsupported type dropped) must still round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);

        Assert.Single(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);
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
}
