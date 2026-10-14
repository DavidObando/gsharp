// <copyright file="Issue1954MultiDimArrayHardeningTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import Xunit

/// Issue #1954/#3354: native rectangular arrays replace flat lowering while
/// preserving all ranks, CLR bounds behavior, aliases, fields, parameters,
/// writes, and index conversions.
open class Issue1954MultiDimArrayHardeningTests {
    @Fact
    func Rank3Access_PreservesAllDimensionsAndIndices() {
        let rendered = Render(`
namespace Corpus.Issue1954
{
    public class Cube
    {
        public static int Run()
        {
            int[,,] cube = new int[2, 3, 4];
            cube[1, 2, 3] = 42;
            return cube[1, 2, 3];
        }
    }
}
`)
        Assert.Contains("let cube = [2, 3, 4]int32", rendered, StringComparison.Ordinal)
        Assert.Contains("cube[1, 2, 3] = 42", rendered, StringComparison.Ordinal)
        Assert.Contains("return cube[1, 2, 3]", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("cubeDim", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("IndexOutOfRangeException", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
        let result = EmittedOracle.Evaluate(rendered + Environment.NewLine + "Cube.Run()")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ImplicitAndTargetTypedRectangularInitializers_UseNativeShapesAndRun() {
        let rendered = Render(`
namespace Corpus.Issue3354
{
    public class Grid
    {
        public static int Run()
        {
            var implicitRect = new[,] { { 1, 2 }, { 3, 4 } };
            int[,] targetTyped = { { 5, 6 }, { 7, 8 } };
            return (implicitRect[1, 0] * 100) + (targetTyped[0, 1] * 10) + targetTyped[1, 1];
        }
    }
}
`)
        Assert.Contains("[2, 2]int32{1, 2, 3, 4}", rendered, StringComparison.Ordinal)
        Assert.Contains("[2, 2]int32{5, 6, 7, 8}", rendered, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(rendered + Environment.NewLine + "Grid.Run()")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        Assert.Null(result.UnhandledException)
        Assert.Equal(368, result.Value)
    }

    @Fact
    func CrossDimensionOutOfRangeIndex_DelegatesBoundsToClrArray() {
        // grid[r, c] with r < rows but c >= cols used to still compute a flat
        // index r*cols + c that is < rows*cols, silently landing on a
        // different, WRONG cell instead of throwing like C# does per-dimension.
        let rendered = Render(`
namespace Corpus.Issue1954
{
    public class Grid
    {
        public static int Run()
        {
            int[,] grid = new int[2, 3];
            return grid[0, 5];
        }
    }
}
`)
        Assert.Contains("grid[0, 5]", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("IndexOutOfRangeException", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func VarAliasOfMultiDimLocal_PreservesNativeType() {
        // Native rectangular type identity follows the value through aliases;
        // no per-local dimension tracking is needed.
        let rendered = Render(`
namespace Corpus.Issue1954
{
    public class Grid
    {
        public static int Run()
        {
            int[,] grid = new int[2, 3];
            var g2 = grid;
            return g2[1, 2];
        }
    }
}
`)
        Assert.Contains("g2[1, 2]", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("gridDim", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("no tracked per-dimension sizes", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func WideIndexExpression_CoercedToInt32JustLikeTheSingleIndexPath() {
        // Issue #1954 item 3: `TranslateMultiDimElementAccess` used raw
        // `TranslateExpression` for indices while the single-index path
        // coerces a wide (non-widening-to-int32) index via
        // `CoerceIndexToInt32`. A `long` index must now get the same
        // `int32(...)` coercion; a `byte` index (which widens to `int32`
        // implicitly in C#) needs none.
        let rendered = Render(`
namespace Corpus.Issue1954
{
    public class Grid
    {
        public static int Run()
        {
            int[,] grid = new int[2, 3];
            long r = 1;
            byte c = 2;
            return grid[r, c];
        }
    }
}
`)
        // The long index is wrapped in the width-bearing int32(...) coercion.
        Assert.Contains("int32(r)", rendered, StringComparison.Ordinal)
        // The byte index needs no coercion call at all.
        Assert.DoesNotContain("int32(c)", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func MultiDimParameter_ElementRead_UsesNativeRank() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", `
namespace Corpus.Issue1954
{
    public class Grid
    {
        public static int Get(int[,] grid, int r, int c)
        {
            return grid[r, c];
        }
    }
}
`)})
        Assert.True(project.BoundWithoutErrors)
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
        let rendered = GSharpPrinter.Print(unit)
        Assert.Empty(context.Diagnostics)
        Assert.Contains("[,]int32", rendered, StringComparison.Ordinal)
        Assert.Contains("grid[r, c]", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func FieldTargetMultiDimElementAssignment_UsesNativeRank() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", `
namespace Corpus.Issue1954
{
    public class Holder
    {
        public int[,] Grid;

        public void Set(int r, int c, int v)
        {
            Grid[r, c] = v;
        }
    }
}
`)})
        Assert.True(project.BoundWithoutErrors)
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
        let rendered = GSharpPrinter.Print(unit)
        Assert.Empty(context.Diagnostics)
        Assert.Contains("[,]int32", rendered, StringComparison.Ordinal)
        Assert.Contains("Grid[r, c] = v", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    shared {
        private func AssertRoundTripParses(rendered string) {
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(rendered)
            Assert.True(
                result!!.Success,
                "Sanitized G# must round-trip-parse. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + rendered
            )
        }

        private func Render(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Source.cs", source)})
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
            Assert.Empty(context.Diagnostics)
            return GSharpPrinter.Print(unit)
        }
    }
}
