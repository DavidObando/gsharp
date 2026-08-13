// <copyright file="Issue1893MultiDimArrayTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #1893/#3354: C# rectangular arrays translate to native G# rectangular
/// arrays. Rank, dimensions, initializers, indexing, and CLR members remain
/// explicit; no flattened backing array or synthetic dimension locals remain.
/// </summary>
public class Issue1893MultiDimArrayTranslationTests
{
    [Fact]
    public void SizedCreation_UsesNativeDimensionsAndPreservesBothIndices()
    {
        string rendered = Render(@"
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
");

        Assert.Contains("let grid = [2, 3]int32", rendered, StringComparison.Ordinal);
        Assert.Contains("grid[0, 0] = 1", rendered, StringComparison.Ordinal);
        Assert.Contains("grid[1, 2] = 6", rendered, StringComparison.Ordinal);
        Assert.Contains("grid[r, c]", rendered, StringComparison.Ordinal);
        Assert.Contains("grid.GetLength(0)", rendered, StringComparison.Ordinal);
        Assert.Contains("grid.GetLength(1)", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("gridDim", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("IndexOutOfRangeException", rendered, StringComparison.Ordinal);

        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void RectangularInitializer_UsesNativeFlatRowMajorInitializer()
    {
        string rendered = Render(@"
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
");

        Assert.Contains("let lit = [2, 3]int32{1, 2, 3, 4, 5, 6}", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("object", rendered, StringComparison.Ordinal);
        Assert.Contains("lit[1, 2]", rendered, StringComparison.Ordinal);

        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ExplicitZeroDimensionInitializer_PreservesEveryDeclaredDimension()
    {
        string rendered = Render(@"
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
");

        Assert.Contains("let grid = [0, 2]int32", rendered, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(rendered + Environment.NewLine + "Grid.Run()");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void ExplicitConstantExpressionDimensions_AreMaterializedForNativeInitializer()
    {
        string rendered = Render(@"
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
");

        Assert.Contains("let grid = [2, 2]int32{1, 2, 3, 4}", rendered, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(rendered + Environment.NewLine + "Grid.Run()");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(4, result.Value);
    }

    [Fact]
    public void FieldMultiDimElementAccess_UsesNativeRankWithoutTracking()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", @"
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
") });

        Assert.True(project.BoundWithoutErrors);
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        Cs2Gs.CodeModel.Ast.CompilationUnit unit =
            new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string rendered = GSharpPrinter.Print(unit);
        Assert.Empty(context.Diagnostics);
        Assert.Contains("[,]int32", rendered, StringComparison.Ordinal);
        Assert.Contains("Grid[r, c]", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void NativeLocalFieldParameterReturnAndSideEffects_TranslatedGSharpBindsEmitsAndRuns()
    {
        string rendered = Render(@"
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
");

        Assert.Contains("[,]int32", rendered, StringComparison.Ordinal);
        Assert.Contains("[2, 2]int32{1, 2, 3, 4}", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("Dim0", rendered, StringComparison.Ordinal);
        var result = EmittedOracle.Evaluate(rendered + Environment.NewLine + "Grid().Run()");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(273, result.Value);
    }

    private static void AssertRoundTripParses(string rendered)
    {
        RoundTripResult result = TranslationTestValidation.AssertBinds(rendered);

        Assert.True(
            result.Success,
            "Sanitized G# must round-trip-parse. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + rendered);
    }

    private static string Render(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", source) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        Cs2Gs.CodeModel.Ast.CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.Empty(context.Diagnostics);
        return GSharpPrinter.Print(unit);
    }
}
