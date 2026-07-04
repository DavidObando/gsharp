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
/// Issue #1954: follow-ups from the #1893/#1952 flat-lowering review.
/// <list type="number">
/// <item>Per-dimension bounds are now enforced on every tracked multi-dim
/// access: <c>grid[r, c]</c> with <c>r</c> in range but <c>c</c> out of range
/// used to still land inside the flat backing array's overall bounds (a
/// silent wrong-cell read/write); it now throws
/// <c>IndexOutOfRangeException</c> like C# does per-dimension.</item>
/// <item>A simple `var` local-to-local alias of a tracked multi-dim local
/// (<c>var g2 = grid;</c>) now keeps the SAME tracking instead of losing it.</item>
/// <item>A wide (`long`/`byte`) index expression is coerced the same way the
/// single-index path coerces it (via `CoerceIndexToInt32`'s widening rule).</item>
/// </list>
/// </summary>
public class Issue1954MultiDimArrayHardeningTests
{
    [Fact]
    public void Rank3Access_FlatLowersAllThreeIndicesWithPerDimensionBoundsChecks()
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

        Assert.Contains("let cubeDim0", rendered, StringComparison.Ordinal);
        Assert.Contains("let cubeDim1", rendered, StringComparison.Ordinal);
        Assert.Contains("let cubeDim2", rendered, StringComparison.Ordinal);
        Assert.Contains(
            "let cube = [cubeDim0 * cubeDim1 * cubeDim2]int32", rendered, StringComparison.Ordinal);

        // All three indices participate in both the row-major flat index and
        // the per-dimension bounds check (issue #1954).
        Assert.Contains(
            "cube[if 1 >= 0 && 1 < cubeDim0 && (2 >= 0 && 2 < cubeDim1) && (3 >= 0 && 3 < cubeDim2) " +
                "{ (1 * cubeDim1 + 2) * cubeDim2 + 3 } else { throw IndexOutOfRangeException()",
            rendered,
            StringComparison.Ordinal);

        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void CrossDimensionOutOfRangeIndex_ThrowsInsteadOfSilentlyReadingWrongCell()
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

        // The read is guarded by a per-dimension bounds check that throws
        // rather than silently computing a wrong-but-in-range flat index.
        Assert.Contains(
            "grid[if 0 >= 0 && 0 < gridDim0 && (5 >= 0 && 5 < gridDim1) { 0 * gridDim1 + 5 } " +
                "else { throw IndexOutOfRangeException()",
            rendered,
            StringComparison.Ordinal);

        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void VarAliasOfTrackedMultiDimLocal_PropagatesTrackingInsteadOfGapping()
    {
        // `var g2 = grid;` used to lose multi-dim tracking entirely, so
        // `g2[r, c]` reported the loud "no tracked per-dimension sizes" gap.
        // A simple local-to-local `var` alias of an already-tracked multi-dim
        // local now keeps the SAME tracking.
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

        // `g2[1, 2]` flattens against grid's OWN hoisted dimensions (g2 has no
        // dimensions of its own — it is the same flat array), proving the
        // alias kept the original MultiDimArrayInfo rather than gapping.
        Assert.Contains(
            "g2[if 1 >= 0 && 1 < gridDim0 && (2 >= 0 && 2 < gridDim1) { 1 * gridDim1 + 2 } " +
                "else { throw IndexOutOfRangeException()",
            rendered,
            StringComparison.Ordinal);
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
    public void FieldTypedMultiDimParameter_ElementRead_StaysLoudGap()
    {
        // A multi-dim array reached through a PARAMETER (not a direct
        // declaration-with-initializer local) has no symbol for the
        // translator to hang per-dimension sizes on.
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
        new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.Contains(
            context.Diagnostics,
            d => d.Message.Contains("no tracked per-dimension sizes", StringComparison.Ordinal));
    }

    [Fact]
    public void FieldTargetMultiDimElementAssignment_StaysLoudGap()
    {
        // `Grid[r, c] = v;` where `Grid` is a FIELD (not a tracked local) has
        // no per-dimension sizes to flatten the WRITE against either — the
        // assignment-target path routes through the same
        // `TranslateMultiDimElementAccess` and must report the same gap.
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
