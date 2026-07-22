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
/// Translator-fidelity tests for issue #1739's source-struct construction
/// cases. Issue #2766 supersedes literal replay for plain structs: their real
/// constructor and call now preserve assignment order and arbitrary logic.
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

        Assert.Contains("init(x int32, y int32)", printed);
        Assert.Contains("P(1, 2)", printed);
    }

    [Fact]
    public void ReadOnlyComputedMember_NeverPickedAsAssignmentTarget()
    {
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

        Assert.Contains("Rect(3, 4)", printed);
        Assert.Contains("prop Area", printed);
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

        Assert.Contains("init(x float64, y float64)", printed);
        Assert.Contains("Vec(1.5, 2.5)", printed);
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

        // Record/data-struct construction remains on its separate primary path.
        Assert.Contains("Pos(1, 2)", printed);
    }

    [Fact]
    public void CtorParameterNotAssignedToAnyMember_PreservesCallableInit()
    {
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
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);
        string printed = GSharpPrinter.Print(unit);
        Assert.Contains("init(value int32, max int32)", printed);
        Assert.Contains("Bounded(value, max)", printed);
    }

    [Fact]
    public void CtorAssignsTransformedValue_PreservesCallableInit()
    {
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
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Unsupported);
        string printed = GSharpPrinter.Print(unit);
        Assert.Contains("Value = raw * 2", printed);
        Assert.Contains("Scaled(raw)", printed);
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
