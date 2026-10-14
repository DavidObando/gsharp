// <copyright file="Issue1893MultiDimArrayTranslationTests.cs" company="GSharp">
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

/// Issue #1893/#3354: C# rectangular arrays translate to native G# rectangular
/// arrays. Rank, dimensions, initializers, indexing, and CLR members remain
/// explicit; no flattened backing array or synthetic dimension locals remain.
open class Issue1893MultiDimArrayTranslationTests {
    @Fact
    func SizedCreation_UsesNativeDimensionsAndPreservesBothIndices() {
        let rendered = Render(`
namespace Corpus.Issue1893
{
    public class Grid
    {
        public static int Run()
        {
            int[,] grid = new int[2, 3];
            grid[0, 0] = 1;
            grid[0, 1] = 2;
            grid[0, 2] = 3;
            grid[1, 0] = 4;
            grid[1, 1] = 5;
            grid[1, 2] = 6;

            int sum = 0;
            for (int r = 0; r < grid.GetLength(0); r++)
            {
                for (int c = 0; c < grid.GetLength(1); c++)
                {
                    sum += grid[r, c];
                }
            }

            return sum;
        }
    }
}
`)
        Assert.Contains("let grid = [2, 3]int32", rendered, StringComparison.Ordinal)
        Assert.Contains("grid[0, 0] = 1", rendered, StringComparison.Ordinal)
        Assert.Contains("grid[1, 2] = 6", rendered, StringComparison.Ordinal)
        Assert.Contains("grid[r, c]", rendered, StringComparison.Ordinal)
        Assert.Contains("grid.GetLength(0)", rendered, StringComparison.Ordinal)
        Assert.Contains("grid.GetLength(1)", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("gridDim", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("IndexOutOfRangeException", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func RectangularInitializer_UsesNativeFlatRowMajorInitializer() {
        let rendered = Render(`
namespace Corpus.Issue1893
{
    public class Grid
    {
        public static int Run()
        {
            int[,] lit = new int[,] { { 1, 2, 3 }, { 4, 5, 6 } };
            return lit[1, 2];
        }
    }
}
`)
        Assert.Contains("let lit = [2, 3]int32{1, 2, 3, 4, 5, 6}", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("object", rendered, StringComparison.Ordinal)
        Assert.Contains("lit[1, 2]", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ExplicitZeroDimensionInitializer_PreservesEveryDeclaredDimension() {
        let rendered = Render(`
namespace Corpus.Issue1893
{
    public class Grid
    {
        public static int Run()
        {
            int[,] grid = new int[0, 2] { };
            return grid.GetLength(0) * 10 + grid.GetLength(1);
        }
    }
}
`)
        Assert.Contains("let grid = [0, 2]int32", rendered, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(rendered + Environment.NewLine + "Grid.Run()")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        Assert.Null(result.UnhandledException)
        Assert.Equal(2, result.Value)
    }

    @Fact
    func ExplicitConstantExpressionDimensions_AreMaterializedForNativeInitializer() {
        let rendered = Render(`
namespace Corpus.Issue1893
{
    public class Grid
    {
        private const int Rows = 2;

        public static int Run()
        {
            int[,] grid = new int[Rows, 1 + 1] { { 1, 2 }, { 3, 4 } };
            return grid[1, 1];
        }
    }
}
`)
        Assert.Contains("let grid = [2, 2]int32{1, 2, 3, 4}", rendered, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(rendered + Environment.NewLine + "Grid.Run()")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        Assert.Null(result.UnhandledException)
        Assert.Equal(4, result.Value)
    }

    @Fact
    func FieldMultiDimElementAccess_UsesNativeRankWithoutTracking() {
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Source.cs", `
namespace Corpus.Issue1893
{
    public class Holder
    {
        public int[,] Grid;

        public int Get(int r, int c)
        {
            return Grid[r, c];
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
        Assert.Contains("Grid[r, c]", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func NativeLocalFieldParameterReturnAndSideEffects_TranslatedGSharpBindsEmitsAndRuns() {
        let rendered = Render(`
namespace Corpus.Issue3354
{
    public sealed class Grid
    {
        private int[,] field = new int[2, 2];
        private int calls;

        private int Index(int value)
        {
            calls++;
            return value;
        }

        private int[,] Echo(int[,] value) => value;

        public int Run()
        {
            int[,] local = new int[,] { { 1, 2 }, { 3, 4 } };
            field = Echo(local);
            field[Index(0), Index(1)] += 5;
            return (calls * 100) + (field[0, 1] * 10) + field[1, 0];
        }
    }
}
`)
        Assert.Contains("[,]int32", rendered, StringComparison.Ordinal)
        Assert.Contains("[2, 2]int32{1, 2, 3, 4}", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("Dim0", rendered, StringComparison.Ordinal)
        let result = EmittedOracle.Evaluate(rendered + Environment.NewLine + "Grid().Run()")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        Assert.Null(result.UnhandledException)
        Assert.Equal(273, result.Value)
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
