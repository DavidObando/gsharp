// <copyright file="Issue1893MultiDimArrayTranslationTests.cs" company="GSharp">
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
/// Issue #1893: a C# rectangular multi-dim array (<c>T[,]</c>) was silently
/// lowered to a 1-D G# array, dropping every index past the first
/// (<c>grid[r, c]</c> translated as if it were <c>grid[r]</c>) — a silent
/// miscompile that crashed at runtime with
/// <c>IndexOutOfRangeException: Array does not have that many dimensions</c>.
/// A separate sub-case, the rectangular initializer
/// (<c>new int[,] {{1, 2, 3}, {4, 5, 6}}</c>), failed to compile entirely
/// (GS0155) because it lowered to a jagged array-of-<c>object</c>.
/// <para>
/// gsc has no rectangular multi-dim array type (only the fixed-length
/// <c>[N]T</c> / slice <c>[]T</c>, both rank 1), so a tracked <c>T[,]</c>
/// local (one declared and initialized in the same statement from
/// <c>new T[d0, d1, ...]</c> or a rectangular initializer) is flat-lowered to
/// a single backing array of length <c>d0*d1*...</c>, with every
/// <c>grid[r, c]</c> access (read and write) and <c>grid.GetLength(k)</c> call
/// rewritten to the faithful row-major flat index/dimension — decision fork
/// B1 (flat lowering), since fork A (native gsc rectangular arrays) is not
/// available in gsc's type system today.
/// </para>
/// </summary>
public class Issue1893MultiDimArrayTranslationTests
{
    [Fact]
    public void SizedCreation_FlatLowersWithHoistedDimensionsAndPreservesBothIndices()
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

        // Flat backing array: length is the product of the two hoisted dims.
        Assert.Contains("let gridDim0", rendered, StringComparison.Ordinal);
        Assert.Contains("let gridDim1", rendered, StringComparison.Ordinal);
        Assert.Contains("let grid = [gridDim0 * gridDim1]int32", rendered, StringComparison.Ordinal);

        // Every write keeps both indices, flattened row-major (r * cols + c).
        Assert.Contains("grid[0 * gridDim1 + 0] = 1", rendered, StringComparison.Ordinal);
        Assert.Contains("grid[1 * gridDim1 + 2] = 6", rendered, StringComparison.Ordinal);

        // The read in the sum loop also keeps both indices.
        Assert.Contains("grid[r * gridDim1 + c]", rendered, StringComparison.Ordinal);

        // GetLength(0)/GetLength(1) resolve to the tracked per-dimension sizes,
        // not a call into a rank-1 CLR array's GetLength (which would throw).
        Assert.Contains("r < gridDim0", rendered, StringComparison.Ordinal);
        Assert.Contains("c < gridDim1", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("GetLength", rendered, StringComparison.Ordinal);

        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void RectangularInitializer_FlatLowersToRealElementArrayNotJaggedObject()
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

        // Flat element-typed slice literal, row-major, NOT nested `[]object{...}`
        // (the #1893 GS0155 compile failure).
        Assert.Contains("let lit = []int32{1, 2, 3, 4, 5, 6}", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("object", rendered, StringComparison.Ordinal);

        // The read keeps both indices, flattened against the constant column
        // count (3) inferred from the initializer's shape.
        Assert.Contains("lit[1 * 3 + 2]", rendered, StringComparison.Ordinal);

        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void UntrackedMultiDimElementAccess_StaysLoudGapInsteadOfSilentlyDroppingIndex()
    {
        // A multi-dim array reached through a field (not a direct
        // declaration-with-initializer local) has no symbol for the translator
        // to hang per-dimension sizes on, so it must report the CS2GS-GAP
        // rather than silently translate `grid[r, c]` as `grid[r]` (the
        // original bug).
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
        new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.Contains(
            context.Diagnostics,
            d => d.Message.Contains("no tracked per-dimension sizes", StringComparison.Ordinal));
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
