// <copyright file="ImportedStructConstructionTranslationTests.cs" company="GSharp">
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
/// Translator-fidelity tests for the construction of value types. A
/// <em>source-defined</em> <c>struct</c> / <c>data struct</c> has no callable
/// constructor surface in G# and is built with a struct literal
/// (<c>T{Field: value, ...}</c>). An <em>imported / BCL</em> struct (e.g.
/// <see cref="System.Guid"/>) is also <c>SpecialType.None</c> yet DOES expose
/// real constructors that G# can call directly (<c>Guid(bytes, true)</c>), so a
/// positional <c>new Guid(...)</c> must be rendered as a constructor call — not
/// zipped into a bogus struct literal over the type's <em>properties</em>
/// (which produced the invalid <c>Guid{Variant: ..., Version: ...}</c> → GS0157).
/// </summary>
public class ImportedStructConstructionTranslationTests
{
    [Fact]
    public void ImportedStruct_PositionalNew_RendersConstructorCall()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public System.Guid Make(byte[] bytes) => new System.Guid(bytes, true);
    }
}");

        Assert.Contains("Guid(bytes, true)", printed);
        Assert.DoesNotContain("Guid{", printed);
    }

    [Fact]
    public void ImportedStruct_TargetTypedNew_RendersConstructorCall()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public System.Guid Make(byte[] bytes)
        {
            System.Guid g = new(bytes, true);
            return g;
        }
    }
}");

        Assert.Contains("Guid(bytes, true)", printed);
        Assert.DoesNotContain("Guid{", printed);
    }

    [Fact]
    public void SourceStruct_PositionalNew_StillRendersStructLiteral()
    {
        // Regression guard: a source-defined value aggregate keeps the canonical
        // G# struct-literal form (no callable ctor surface in G#).
        string printed = TranslateUnit(@"
namespace Demo
{
    public struct Point
    {
        public int X { get; }
        public int Y { get; }
        public Point(int x, int y) { X = x; Y = y; }
    }

    public class C
    {
        public Point Make() => new Point(1, 2);
    }
}");

        Assert.Contains("Point{", printed);
        Assert.Contains("X: 1", printed);
        Assert.Contains("Y: 2", printed);
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
