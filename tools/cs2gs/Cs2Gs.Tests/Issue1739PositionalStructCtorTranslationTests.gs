// <copyright file="Issue1739PositionalStructCtorTranslationTests.cs" company="GSharp">
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

/// Translator-fidelity tests for issue #1739's source-struct construction
/// cases. Issue #2766 supersedes literal replay for plain structs: their real
/// constructor and call now preserve assignment order and arbitrary logic.
open class Issue1739PositionalStructCtorTranslationTests {
    @Fact
    func MemberOrderDiffersFromCtorOrder_MapsByCtorAssignment_NotDeclarationOrder() {
        let printed = TranslateUnit(`
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
}`)
        Assert.Contains("init(x int32, y int32)", printed)
        Assert.Contains("P(1, 2)", printed)
    }

    @Fact
    func ReadOnlyComputedMember_NeverPickedAsAssignmentTarget() {
        let printed = TranslateUnit(`
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
}`)
        Assert.Contains("Rect(3, 4)", printed)
        Assert.Contains("prop Area", printed)
    }

    @Fact
    func FieldBasedStruct_OutOfOrderCtorAssignment_MapsCorrectly() {
        let printed = TranslateUnit(`
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
}`)
        Assert.Contains("init(x float64, y float64)", printed)
        Assert.Contains("Vec(1.5, 2.5)", printed)
    }

    @Fact
    func RecordStructPrimaryConstructor_PositionalNew_CallsPrimaryConstructor() {
        let printed = TranslateUnit(`
namespace Demo
{
    public record struct Pos(int X, int Y);

    public class C
    {
        public Pos Make() => new Pos(1, 2);
    }
}`)
        // Record/data-struct construction remains on its separate primary path.
        Assert.Contains("Pos(1, 2)", printed)
    }

    @Fact
    func CtorParameterNotAssignedToAnyMember_PreservesCallableInit() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Snippet.cs", `
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
}`)})
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
        )
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
        let printed = GSharpPrinter.Print(unit)
        Assert.Contains("init(value int32, max int32)", printed)
        Assert.Contains("Bounded(value, max)", printed)
    }

    @Fact
    func CtorAssignsTransformedValue_PreservesCallableInit() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Snippet.cs", `
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
}`)})
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
        )
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
        )
        let printed = GSharpPrinter.Print(unit)
        Assert.Contains("Value = raw * 2", printed)
        Assert.Contains("Scaled(raw)", printed)
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
