// <copyright file="L2TranslationTests.cs" company="GSharp">
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

/// Targeted translation tests for the L2-Library constructs (issue #914,
/// ADR-0115 §B): interface members carry no `open`, C# casts become
/// width-bearing G# conversions, object initializers become struct literals,
/// `with`-expressions are preserved, sibling `shared` static calls are
/// qualified through their owning type, and xUnit attributes map to G#
/// attribute applications. Each test uses a uniquely named user type so the
/// snippets never collide within a single compilation.
open class L2TranslationTests {
    /// ADR-0115 §B.6: interface members are implicitly abstract, so the
    /// translator never emits `open` on them — the canonical G# form is the
    /// plain `func`/`prop` signature (see `samples/InterfaceUpcast.gs`).
    @Fact
    func InterfaceMembers_HaveNoOpen() {
        let printed = TranslateUnit(`
namespace Demo
{
    public interface IShapeKindOnly
    {
        int Kind { get; }
        double AreaOf();
    }
}`)
        Assert.Contains("interface IShapeKindOnly {", printed)
        Assert.Contains("prop Kind int32 {", printed)
        Assert.Contains("func AreaOf() float64;", printed)
        Assert.DoesNotContain("open", printed)
    }

    /// ADR-0115 §B.17: a C# explicit numeric cast `(int)expr` becomes the
    /// width-bearing G# conversion call `int32(expr)`. This is
    /// behaviour-faithful — the CLR truncates a `float64` toward zero just
    /// as C# `(int)` does, so `ToCents(1.234)` still yields `123`.
    @Fact
    func Cast_TranslatesToWidthConversion() {
        let printed = TranslateUnit(`
namespace Demo
{
    public static class CastHost
    {
        public static int ToCents(double dollars) => (int)(dollars * 100.0);
    }
}`)
        Assert.Contains("int32(", printed)
        Assert.Contains("dollars * 100.0", printed)
        Assert.DoesNotContain("return nil", printed)
    }

    /// ADR-0115 §B.16: a C# object initializer `new T { Field = v }` on a
    /// value type maps to the G# composite (struct) literal `T{Field: v}`.
    @Fact
    func ObjectInitializer_TranslatesToStructLiteral() {
        let printed = TranslateUnit(`
namespace Demo
{
    public struct BoxDims
    {
        public double Width { get; set; }
        public double Height { get; set; }
    }

    public static class BoxHost
    {
        public static BoxDims Make() => new BoxDims { Width = 6.0, Height = 7.0 };
    }
}`)
        Assert.Contains("BoxDims{Width: 6.0, Height: 7.0}", printed)
    }

    /// Issue #946: a C# `init` accessor maps to a first-class G# `init`
    /// accessor (previously mapped to `set` with a gap diagnostic per
    /// ADR-0115 §B.11).
    @Fact
    func InitAccessor_TranslatesToInit() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class Config
    {
        public string Name { get; init; }
    }
}`)
        Assert.Contains("get;", printed)
        Assert.Contains("init;", printed)
        Assert.DoesNotContain("set;", printed)
    }

    /// ADR-0115 §B.15: a C# `with`-expression maps to the canonical G#
    /// `expr with { Field = value }` form (using `=`); an empty update
    /// list renders `expr with { }`.
    @Fact
    func WithExpression_TranslatesToWith() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed record Tone(string Name, int Rgb)
    {
        public Tone Recolor() => this with { Name = "green", Rgb = 0x00FF00 };

        public Tone Copy() => this with { };
    }
}`)
        Assert.Contains("with { Name = \"green\", Rgb = 0x00FF00 }", printed)
        Assert.Contains("with { }", printed)
    }

    /// ADR-0115 §B.18 / issue #3471: a C# bare sibling static call inside its
    /// own declaring type (`Two(value, 2)`) stays bare, because gsc
    /// resolves bare sibling `shared` references from anywhere inside the
    /// declaring aggregate's body; only sites that leave the type scope keep
    /// the owning-type qualifier.
    @Fact
    func SiblingStaticCall_EmitsBareInsideOwningType() {
        let printed = TranslateUnit(`
namespace Demo
{
    public static class RoundHost
    {
        public static double One(double value) => Two(value, 2);

        public static double Two(double value, int digits) => value;
    }
}`)
        Assert.Contains("Two(value, 2)", printed)
        Assert.DoesNotContain("RoundHost.Two(value, 2)", printed)
    }

    /// ADR-0115 §B.11: xUnit `[Fact]`/`[Theory]`/`[InlineData(...)]`
    /// attributes map to the G# `@Fact`/`@Theory`/`@InlineData(...)`
    /// attribute applications, with `float64` inline-data spellings
    /// preserved verbatim.
    @Fact
    func XUnitAttributes_MapToGSharpApplications() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class FactAttribute : System.Attribute { }
    public sealed class TheoryAttribute : System.Attribute { }
    public sealed class InlineDataAttribute : System.Attribute
    {
        public InlineDataAttribute(params object[] data) { }
    }

    public sealed class TonesUnderTest
    {
        [Fact]
        public void Single() { }

        [Theory]
        [InlineData(3.0, 4.0, 12.0)]
        public void Cases(double width, double height, double area) { }
    }
}`)
        Assert.Contains("@Fact", printed)
        Assert.Contains("@Theory", printed)
        Assert.Contains("@InlineData(3.0, 4.0, 12.0)", printed)
    }

    /// ADR-0115 §B.12: a C# float literal keeps its spelling (`2.0` stays
    /// `2.0`) because G# has no implicit numeric promotion; collapsing it to
    /// `2` would type as `int32` and break `int32 * float64`.
    @Fact
    func FloatLiteral_PreservesSpelling() {
        let printed = TranslateUnit(`
namespace Demo
{
    public static class LiteralHost
    {
        public static double Twice(double radius) => 2.0 * radius;
    }
}`)
        Assert.Contains("2.0 * radius", printed)
    }

    /// ADR-0117 (issue #479): a C# list collection initializer
    /// `new List<int>{1, 2, 3}` maps to the canonical G# collection
    /// initializer `List[int32]{ 1, 2, 3 }` (bare elements → `Add`),
    /// rather than dropping the elements as the pre-ADR-0117 translator did.
    @Fact
    func ListCollectionInitializer_TranslatesToCollectionInitializer() {
        let printed = TranslateUnit(`
using System.Collections.Generic;
namespace Demo
{
    public static class ListHost
    {
        public static List<int> Make() => new List<int> { 1, 2, 3 };
    }
}`)
        Assert.Contains("List[int32]{ 1, 2, 3 }", printed)
    }

    /// ADR-0117 (issue #479): a C# dictionary collection initializer using the
    /// complex element form `{ {"a", 1} }` maps to the canonical G#
    /// `key: value` pair form `Dictionary[string, int32]{ "a": 1, ... }`.
    @Fact
    func DictionaryComplexInitializer_TranslatesToKeyedPairs() {
        let printed = TranslateUnit(`
using System.Collections.Generic;
namespace Demo
{
    public static class DictHost
    {
        public static Dictionary<string, int> Make() =>
            new Dictionary<string, int> { { "a", 1 }, { "b", 2 } };
    }
}`)
        Assert.Contains("Dictionary[string, int32]{ \"a\": 1, \"b\": 2 }", printed)
    }

    /// ADR-0117 (issue #479): a C# dictionary indexer initializer
    /// `{ ["a"] = 1 }` maps to the canonical G# indexed element form
    /// `Dictionary[string, int32]{ ["a"] = 1 }`, and constructor arguments
    /// (a comparer) are preserved on the construction target — the analogue of
    /// the C# `new(StringComparer.OrdinalIgnoreCase){ ... }` case.
    @Fact
    func DictionaryIndexedInitializer_WithComparer_TranslatesToIndexedElements() {
        let printed = TranslateUnit(`
using System;
using System.Collections.Generic;
namespace Demo
{
    public static class HeaderHost
    {
        public static Dictionary<string, int> Make() =>
            new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase) { ["Key"] = 5 };
    }
}`)
        Assert.Contains("Dictionary[string, int32](StringComparer.OrdinalIgnoreCase){ [\"Key\"] = 5 }", printed)
    }

    /// Issue #947: a C# `readonly` field assigned inside a constructor whose
    /// body is not a simple parameter-to-member copy (so the primary-constructor
    /// lift does not apply) now translates to a G# `let` field that the
    /// emitted `init(...)` constructor assigns directly — which is valid G#
    /// now that `let` fields carry C# `readonly`-field semantics.
    @Fact
    func ReadonlyField_AssignedInNonLiftableConstructor_TranslatesToLetWithInit() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class StampX
    {
        private readonly int doubled;
        public StampX(int n)
        {
            this.doubled = n * 2;
        }
        public int Doubled => this.doubled;
    }
}`)
        Assert.Contains("let doubled int32", printed)
        Assert.Contains("init(n int32)", printed)
        Assert.Contains("doubled = n * 2", printed)
        Assert.DoesNotContain("var doubled", printed)
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
