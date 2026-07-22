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
/// <em>source-defined</em> plain struct with an explicit constructor now keeps
/// a callable <c>init</c>; data structs and default/object initialization use
/// struct literals. An <em>imported / BCL</em> struct (e.g.
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
    public void SourceStruct_PositionalNew_RendersPreservedConstructorCall()
    {
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

        Assert.Contains("init(x int32, y int32)", printed);
        Assert.Contains("Point(1, 2)", printed);
    }

    /// <summary>
    /// A parameterless <c>new T()</c> on a source-defined value <c>struct</c>
    /// must render as the empty struct literal <c>T{}</c> — a value struct has
    /// no callable constructor surface in G#, so emitting a <c>T()</c> call
    /// would surface as GS0130 ("function 'T' doesn't exist").
    /// </summary>
    [Fact]
    public void SourceStruct_ParameterlessNew_RendersEmptyStructLiteral()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public struct ChunkFrames
    {
        public uint FirstFrameIndex { get; init; }
        public uint NumberOfFrames { get; init; }
    }

    public class C
    {
        public ChunkFrames Make() => new ChunkFrames();
    }
}");

        Assert.Contains("ChunkFrames{}", printed);
        Assert.DoesNotContain("ChunkFrames()", printed);
    }

    /// <summary>
    /// A target-typed <c>new() { Field = value, ... }</c> on a source value
    /// <c>struct</c> must render as the struct literal <c>T{Field: value, ...}</c>;
    /// previously the target-typed object initializer was silently dropped, emitting
    /// a bare <c>T()</c> call (GS0130).
    /// </summary>
    [Fact]
    public void SourceStruct_TargetTypedNewWithInitializer_RendersStructLiteral()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public readonly record struct ChunkFrames
    {
        public uint FirstFrameIndex { get; init; }
        public uint NumberOfFrames { get; init; }
    }

    public class C
    {
        public ChunkFrames Make(uint a, uint b)
        {
            ChunkFrames result = new() { FirstFrameIndex = a, NumberOfFrames = b };
            return result;
        }
    }
}");

        Assert.Contains("FirstFrameIndex: a", printed);
        Assert.Contains("NumberOfFrames: b", printed);
        Assert.DoesNotContain("ChunkFrames()", printed);
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
