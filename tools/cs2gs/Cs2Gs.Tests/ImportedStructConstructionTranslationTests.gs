// <copyright file="ImportedStructConstructionTranslationTests.cs" company="GSharp">
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

/// Translator-fidelity tests for the construction of value types. A
/// <em>source-defined</em> plain struct with an explicit constructor now keeps
/// a callable `init`; data structs and default/object initialization use
/// struct literals. An <em>imported / BCL</em> struct (e.g.
/// (cref:System.Guid)) is also `SpecialType.None` yet DOES expose
/// real constructors that G# can call directly (`Guid(bytes, true)`), so a
/// positional `new Guid(...)` must be rendered as a constructor call — not
/// zipped into a bogus struct literal over the type's <em>properties</em>
/// (which produced the invalid `Guid{Variant: ..., Version: ...}` → GS0157).
open class ImportedStructConstructionTranslationTests {
    @Fact
    func ImportedStruct_PositionalNew_RendersConstructorCall() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public System.Guid Make(byte[] bytes) => new System.Guid(bytes, true);
    }
}`)
        Assert.Contains("Guid(bytes, true)", printed)
        Assert.DoesNotContain("Guid{", printed)
    }

    @Fact
    func ImportedStruct_TargetTypedNew_RendersConstructorCall() {
        let printed = TranslateUnit(`
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
}`)
        Assert.Contains("Guid(bytes, true)", printed)
        Assert.DoesNotContain("Guid{", printed)
    }

    @Fact
    func SourceStruct_PositionalNew_RendersPreservedConstructorCall() {
        let printed = TranslateUnit(`
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
}`)
        Assert.Contains("init(x int32, y int32)", printed)
        Assert.Contains("Point(1, 2)", printed)
    }

    /// A parameterless `new T()` on a source-defined value `struct`
    /// must render as the empty struct literal `T{}` — a value struct has
    /// no callable constructor surface in G#, so emitting a `T()` call
    /// would surface as GS0130 ("function 'T' doesn't exist").
    @Fact
    func SourceStruct_ParameterlessNew_RendersEmptyStructLiteral() {
        let printed = TranslateUnit(`
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
}`)
        Assert.Contains("ChunkFrames{}", printed)
        Assert.DoesNotContain("ChunkFrames()", printed)
    }

    /// A target-typed `new() { Field = value, ... }` on a source value
    /// `struct` must render as the struct literal `T{Field: value, ...}`;
    /// previously the target-typed object initializer was silently dropped, emitting
    /// a bare `T()` call (GS0130).
    @Fact
    func SourceStruct_TargetTypedNewWithInitializer_RendersStructLiteral() {
        let printed = TranslateUnit(`
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
}`)
        Assert.Contains("FirstFrameIndex: a", printed)
        Assert.Contains("NumberOfFrames: b", printed)
        Assert.DoesNotContain("ChunkFrames()", printed)
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
