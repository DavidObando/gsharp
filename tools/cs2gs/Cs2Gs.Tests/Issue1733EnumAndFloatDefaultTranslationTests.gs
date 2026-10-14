// <copyright file="Issue1733EnumAndFloatDefaultTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// Issue #1733: `MapConstantDefault` and `MapAttributeArgumentValue`
/// previously rendered an enum-typed default/attribute-argument as its boxed
/// underlying integer (e.g. `3`) rather than the enum member it names.
/// (cref:CSharpToGSharpTranslator.VisitEnumDeclaration) drops the C#
/// explicit case values, so a translated enum is renumbered by declaration
/// order — the raw integer could silently name the WRONG member (or none) under
/// the new numbering. Enum-typed constants now resolve to the qualified member
/// reference (`EnumType.Member`), a `[Flags]` OR-combination when no
/// single member matches, or a visible `Unsupported` diagnostic when
/// neither applies. Separately, `double.NaN`/`PositiveInfinity`/
/// `NegativeInfinity` (and the `float` equivalents) previously
/// rendered as the bare, unresolved identifiers `NaN`/`Infinity`;
/// they now render as the qualified BCL member (`System.Double.NaN`, …).
open class Issue1733EnumAndFloatDefaultTranslationTests {
    @Fact
    func EnumParameterDefault_RendersAsMemberReference_NotRawInt() {
        let rendered = Render()
        Assert.Contains("c Color = Color.Blue", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("c Color = 2", rendered, StringComparison.Ordinal)
    }

    @Fact
    func FlagsEnumParameterDefault_RendersAsOrOfMembers() {
        let rendered = Render()
        // Decomposed in descending-value order (Olives=2 before Cheese=1).
        Assert.Contains("t Toppings = Toppings.Olives | Toppings.Cheese", rendered, StringComparison.Ordinal)
    }

    // N2: a ulong [Flags] enum member above long.MaxValue must not crash
    // Convert.ToInt64 (OverflowException) and must resolve/decompose correctly.
    @Fact
    func UInt64FlagsEnumWithHighBitMember_DoesNotCrash_AndRendersAsOrOfMembers() {
        let rendered = Render()
        Assert.Contains("b BigFlags = BigFlags.Big | BigFlags.Small", rendered, StringComparison.Ordinal)
    }

    @Fact
    func UndefinedEnumValue_ReportsUnsupported() {
        let (_, context) = Translate()
        Assert.Contains(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.IsUnsupported && d.Message!!.Contains("'99'", StringComparison.Ordinal)
        )
    }

    @Fact
    func EnumAttributeArgument_RendersAsMemberReference_NotRawInt() {
        let rendered = Render()
        Assert.Contains("@Kind(Color.Green)", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("@Kind(1)", rendered, StringComparison.Ordinal)
    }

    @Fact
    func FiniteFloatDefaults_StillRenderAsLiterals() {
        let rendered = Render()
        Assert.Contains("d float64 = 1.5", rendered, StringComparison.Ordinal)
        Assert.Contains("f float32 = 2.5", rendered, StringComparison.Ordinal)
    }

    @Fact
    func DoubleSpecialDefaults_RenderAsQualifiedBclMembers_NotBareIdentifiers() {
        let rendered = Render()
        Assert.Contains("nan float64 = System.Double.NaN", rendered, StringComparison.Ordinal)
        Assert.Contains("posInf float64 = System.Double.PositiveInfinity", rendered, StringComparison.Ordinal)
        Assert.Contains("negInf float64 = System.Double.NegativeInfinity", rendered, StringComparison.Ordinal)
    }

    @Fact
    func FloatSpecialDefaults_RenderAsQualifiedBclMembers_NotBareIdentifiers() {
        let rendered = Render()
        Assert.Contains("nan float32 = System.Single.NaN", rendered, StringComparison.Ordinal)
        Assert.Contains("posInf float32 = System.Single.PositiveInfinity", rendered, StringComparison.Ordinal)
        Assert.Contains("negInf float32 = System.Single.NegativeInfinity", rendered, StringComparison.Ordinal)
    }

    // Native named arguments leave skipped metadata defaults to gsc's CLR
    // binder; cs2gs no longer reconstructs the unmatched enum value.
    @Fact
    func MetadataEnumParameterDefault_WithNoMatchingMember_PreservesNamedCall() {
        let libraryReference = CompileExternalLibraryReference()
        const CallerSource = `
namespace Corpus.Issue1733.Caller
{
    public class Caller
    {
        public void Invoke()
        {
            ExternalLib.Service.Configure(extra: 5);
        }
    }
}
`
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, CallerSource string){("Caller.cs", CallerSource)},
            CSharpProjectLoader.RuntimeReferences().Append(libraryReference).ToImmutableArray()
        )
        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
        )
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
        let printed = GSharpPrinter.Print(unit)
        Assert.DoesNotContain(context.Diagnostics, (diagnostic TranslationDiagnostic) -> diagnostic.IsUnsupported)
        Assert.Contains("Service.Configure(extra: 5)", printed, StringComparison.Ordinal)
    }

    shared {
        private const Source string = `
using System;

namespace Corpus.Issue1733
{
    public enum Color { Red, Green, Blue }

    [Flags]
    public enum Toppings { None = 0, Cheese = 1, Olives = 2, Pepperoni = 4 }

    // N2: a ulong-backed [Flags] enum with a high-bit member above
    // long.MaxValue. Convert.ToInt64 throws OverflowException on such a value;
    // MapEnumConstant must resolve/decompose it without crashing.
    [Flags]
    public enum BigFlags : ulong
    {
        None = 0,
        Small = 1UL,
        Big = 0x8000_0000_0000_0000UL,
    }

    public class KindAttribute : Attribute
    {
        public KindAttribute(Color color) { }
    }

    public class Widgets
    {
        public void Paint(Color c = Color.Blue) { }

        public void Sprinkle(Toppings t = Toppings.Cheese | Toppings.Olives) { }

        public void BigFlagCombo(BigFlags b = BigFlags.Big | BigFlags.Small) { }

        public void Undefined(Color c = (Color)99) { }

        [Kind(Color.Green)]
        public void Tagged() { }

        public void FiniteFloat(double d = 1.5, float f = 2.5f) { }

        public void SpecialDouble(
            double nan = double.NaN,
            double posInf = double.PositiveInfinity,
            double negInf = double.NegativeInfinity) { }

        public void SpecialFloat(
            float nan = float.NaN,
            float posInf = float.PositiveInfinity,
            float negInf = float.NegativeInfinity) { }
    }
}
`

        private func CompileExternalLibraryReference() MetadataReference {
            const LibrarySource = `
namespace ExternalLib
{
    public enum Level { Low = 1, High = 2 }

    public static class Service
    {
        public static void Configure(string name = "a", Level level = (Level)99, int extra = 0) { }
    }
}
`
            let tree = CSharpSyntaxTree.ParseText(LibrarySource, CSharpParseOptions(LanguageVersion.Latest))
            let compilation = CSharpCompilation.Create(
                "Cs2Gs.Issue1733.ExternalLib",
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let stream = MemoryStream()
            let emitResult = compilation.Emit(stream)
            Assert.True(
                emitResult.Success,
                "external library fixture should compile: " + string.Join(Environment.NewLine, emitResult.Diagnostics)
            )
            stream.Position = 0
            return MetadataReference.CreateFromStream(stream)
        }

        private func Render() string {
            let (unit, _) = Translate()
            return GSharpPrinter.Print(unit)
        }

        private func Translate()(Unit CompilationUnit, Context TranslationContext) {
            let project = CSharpProjectLoader.LoadInMemory([](string, Source string){("Widgets.cs", Source)})
            Assert.True(
                project.BoundWithoutErrors,
                "inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return (unit, context)
        }
    }
}
