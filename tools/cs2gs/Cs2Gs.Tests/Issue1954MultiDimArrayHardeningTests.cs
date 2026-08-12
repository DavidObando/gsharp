// <copyright file="Issue1954MultiDimArrayHardeningTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #1954/#3354: native rectangular arrays replace flat lowering while
/// preserving all ranks, CLR bounds behavior, aliases, fields, parameters,
/// writes, and index conversions.
/// </summary>
public class Issue1954MultiDimArrayHardeningTests
{
    [Fact]
    public void Rank3Access_PreservesAllDimensionsAndIndices()
    {
        string rendered = Render(@"
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
");

        Assert.Contains("let cube = [2, 3, 4]int32", rendered, StringComparison.Ordinal);
        Assert.Contains("cube[1, 2, 3] = 42", rendered, StringComparison.Ordinal);
        Assert.Contains("return cube[1, 2, 3]", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("cubeDim", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("IndexOutOfRangeException", rendered, StringComparison.Ordinal);

        AssertRoundTripParses(rendered);
        var result = GSharp.Tests.EmittedOracle.Evaluate(rendered + Environment.NewLine + "Cube.Run()");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ImplicitAndTargetTypedRectangularInitializers_UseNativeShapesAndRun()
    {
        string rendered = Render(@"
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
");

        Assert.Contains("[2, 2]int32{1, 2, 3, 4}", rendered, StringComparison.Ordinal);
        Assert.Contains("[2, 2]int32{5, 6, 7, 8}", rendered, StringComparison.Ordinal);
        var result = GSharp.Tests.EmittedOracle.Evaluate(rendered + Environment.NewLine + "Grid.Run()");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        Assert.Equal(368, result.Value);
    }

    [Fact]
    public void CrossDimensionOutOfRangeIndex_DelegatesBoundsToClrArray()
    {
        // grid[r, c] with r < rows but c >= cols used to still compute a flat
        // index r*cols + c that is < rows*cols, silently landing on a
        // different, WRONG cell instead of throwing like C# does per-dimension.
        string rendered = Render(@"
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
");

        Assert.Contains("grid[0, 5]", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("IndexOutOfRangeException", rendered, StringComparison.Ordinal);

        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void VarAliasOfMultiDimLocal_PreservesNativeType()
    {
        // Native rectangular type identity follows the value through aliases;
        // no per-local dimension tracking is needed.
        string rendered = Render(@"
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
");

        Assert.Contains("g2[1, 2]", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("gridDim", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("no tracked per-dimension sizes", rendered, StringComparison.Ordinal);

        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void WideIndexExpression_CoercedToInt32JustLikeTheSingleIndexPath()
    {
        // Issue #1954 item 3: `TranslateMultiDimElementAccess` used raw
        // `TranslateExpression` for indices while the single-index path
        // coerces a wide (non-widening-to-int32) index via
        // `CoerceIndexToInt32`. A `long` index must now get the same
        // `int32(...)` coercion; a `byte` index (which widens to `int32`
        // implicitly in C#) needs none.
        string rendered = Render(@"
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
");

        // The long index is wrapped in the width-bearing int32(...) coercion.
        Assert.Contains("int32(r)", rendered, StringComparison.Ordinal);

        // The byte index needs no coercion call at all.
        Assert.DoesNotContain("int32(c)", rendered, StringComparison.Ordinal);

        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void MultiDimParameter_ElementRead_UsesNativeRank()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", @"
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
") });

        Assert.True(project.BoundWithoutErrors);
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        Cs2Gs.CodeModel.Ast.CompilationUnit unit =
            new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string rendered = GSharpPrinter.Print(unit);
        Assert.Empty(context.Diagnostics);
        Assert.Contains("[,]int32", rendered, StringComparison.Ordinal);
        Assert.Contains("grid[r, c]", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void FieldTargetMultiDimElementAssignment_UsesNativeRank()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", @"
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
") });

        Assert.True(project.BoundWithoutErrors);
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        Cs2Gs.CodeModel.Ast.CompilationUnit unit =
            new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string rendered = GSharpPrinter.Print(unit);
        Assert.Empty(context.Diagnostics);
        Assert.Contains("[,]int32", rendered, StringComparison.Ordinal);
        Assert.Contains("Grid[r, c] = v", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    private static void AssertRoundTripParses(string rendered)
    {
        RoundTripResult result = GSharpRoundTrip.Validate(rendered);

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
