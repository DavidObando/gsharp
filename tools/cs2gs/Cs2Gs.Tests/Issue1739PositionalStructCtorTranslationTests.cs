// <copyright file="Issue1739PositionalStructCtorTranslationTests.cs" company="GSharp">
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
/// Translator-fidelity tests for issue #1739 — a positional <c>new T(a, b, c)</c>
/// on a SOURCE struct used to zip the constructor arguments to the struct's
/// members by bare DECLARATION order, ignoring the constructor's actual
/// parameter→member assignments (silently swapping/misassigning values
/// whenever a struct's member order differs from its constructor's parameter
/// order), and its "settable" member filter actually tested READABILITY. The
/// fix resolves the exact constructor Roslyn bound for the call site and walks
/// its body for the trivial per-parameter assign-through pattern; anything
/// that does not fit that pattern is reported unsupported rather than guessed.
/// </summary>
public class Issue1739PositionalStructCtorTranslationTests
{
    [Fact]
    public void MemberOrderDiffersFromCtorOrder_MapsByCtorAssignment_NotDeclarationOrder()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public struct P
    {
        public int Y { get; }
        public int X { get; }
        public P(int x, int y) { X = x; Y = y; }
    }

    public class C
    {
        public P Make() => new P(1, 2);
    }
}");

        Assert.Contains("P{X: 1, Y: 2}", printed);
        Assert.DoesNotContain("P{Y: 1, X: 2}", printed);
    }

    [Fact]
    public void ReadOnlyComputedMember_NeverPickedAsAssignmentTarget()
    {
        // Bug #2: the old filter tested `GetMethod != null` (readability) instead
        // of true settability, so a get-only COMPUTED property (no backing
        // storage, `=>` bodied) could still shift into the positional zip. It
        // cannot be a ctor-assignment target (a ctor cannot legally assign it),
        // so it must never appear in the struct literal.
        string printed = TranslateUnit(@"
namespace Demo
{
    public struct Rect
    {
        public int Width { get; }
        public int Height { get; }
        public int Area => Width * Height;
        public Rect(int width, int height) { Width = width; Height = height; }
    }

    public class C
    {
        public Rect Make() => new Rect(3, 4);
    }
}");

        Assert.Contains("Rect{Width: 3, Height: 4}", printed);
        Assert.DoesNotContain("Area:", printed);
    }

    [Fact]
    public void FieldBasedStruct_OutOfOrderCtorAssignment_MapsCorrectly()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public struct Vec
    {
        public double Y;
        public double X;
        public Vec(double x, double y) { X = x; Y = y; }
    }

    public class C
    {
        public Vec Make() => new Vec(1.5, 2.5);
    }
}");

        Assert.Contains("Vec{X: 1.5, Y: 2.5}", printed);
        Assert.DoesNotContain("Vec{Y: 1.5, X: 2.5}", printed);
    }

    [Fact]
    public void RecordStructPrimaryConstructor_PositionalNew_CallsPrimaryConstructor()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public record struct Pos(int X, int Y);

    public class C
    {
        public Pos Make() => new Pos(1, 2);
    }
}");

        // `data struct Pos(X, Y)` gets its own real, directly callable primary
        // constructor in G#, so the positional call maps straight to it — not to
        // a struct literal (unlike the plain-struct case above).
        Assert.Contains("Pos(1, 2)", printed);
    }

    [Fact]
    public void CtorParameterNotAssignedToAnyMember_ReportsUnsupported()
    {
        // `max` feeds no member (e.g. it would drive validation logic elsewhere) —
        // a struct literal has no ctor body to run that logic in, so the
        // translator must flag the gap rather than guess a member for it.
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("Snippet.cs", @"
namespace Demo
{
    public struct Bounded
    {
        public int Value { get; }
        public Bounded(int value, int max) { Value = value; }
    }

    public class C
    {
        public Bounded Make(int value, int max) => new Bounded(value, max);
    }
}"),
        });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        _ = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.Contains(
            context.Diagnostics,
            d => d.Message.Contains("issue #1739", StringComparison.Ordinal));
    }

    [Fact]
    public void CtorAssignsTransformedValue_ReportsUnsupported()
    {
        // `Value = raw * 2` is a transformation, not a plain parameter
        // assign-through — a struct literal cannot replay that logic.
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("Snippet.cs", @"
namespace Demo
{
    public struct Scaled
    {
        public int Value { get; }
        public Scaled(int raw) { Value = raw * 2; }
    }

    public class C
    {
        public Scaled Make(int raw) => new Scaled(raw);
    }
}"),
        });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        _ = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.Contains(
            context.Diagnostics,
            d => d.Message.Contains("issue #1739", StringComparison.Ordinal));
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
