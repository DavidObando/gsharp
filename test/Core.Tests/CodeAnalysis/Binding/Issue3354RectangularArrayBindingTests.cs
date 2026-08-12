// <copyright file="Issue3354RectangularArrayBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Symbols.Display;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>Binding, identity, and diagnostic coverage for issue #3354.</summary>
public class Issue3354RectangularArrayBindingTests
{
    [Fact]
    public void AllocationReadWriteFieldsParametersReturnsAndGenerics_Bind()
    {
        var diagnostics = Bind(
            """
            package P
            func Echo[T](value [,]T) [,]T { return value }
            func Set(value [,]int32, row int32, column int32) {
                value[row, column] = 42
            }
            var field [,]int32 = [2, 3]int32
            let returned = Echo[int32](field)
            Set(returned, 1, 2)
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void IndexArityMismatch_ReportsGs0527()
    {
        Assert.Contains(
            Bind("package P\nlet value = [2, 3]int32\nlet item = value[0]\n"),
            diagnostic => diagnostic.Id == "GS0527");
    }

    [Fact]
    public void WriteAndCompoundIndexArityMismatch_ReportGs0527()
    {
        var diagnostics = Bind(
            "package P\nvar value = [2, 3]int32\nvalue[0] = 1\nvalue[0] += 1\n");

        Assert.Equal(2, diagnostics.Count(diagnostic => diagnostic.Id == "GS0527"));
    }

    [Fact]
    public void NonIntegralDimensionAndIndex_ReportConversionErrors()
    {
        var diagnostics = Bind(
            "package P\nlet value = [true, 2]int32\nlet other = [1, 1]int32\nlet item = other[false, 0]\n");

        Assert.True(diagnostics.Count(diagnostic => diagnostic.IsError) >= 2);
    }

    [Fact]
    public void RankAboveClrLimit_ReportsGs0528()
    {
        var dimensions = string.Join(", ", new string[33]);
        Assert.Contains(
            Bind($"package P\nvar value [{dimensions}]int32\n"),
            diagnostic => diagnostic.Id == "GS0528");
    }

    [Fact]
    public void InitializerWithRuntimeDimensions_ReportsGs0529()
    {
        Assert.Contains(
            Bind("package P\nlet rows = 2\nlet value = [rows, 2]int32{1, 2, 3, 4}\n"),
            diagnostic => diagnostic.Id == "GS0529");
    }

    [Fact]
    public void InitializerElementCountMismatch_ReportsGs0530()
    {
        Assert.Contains(
            Bind("package P\nlet value = [2, 3]int32{1, 2, 3}\n"),
            diagnostic => diagnostic.Id == "GS0530");
    }

    [Fact]
    public void Symbols_IncludeRankInIdentityDisplayAndClrProjection()
    {
        var rank2 = RectangularArrayTypeSymbol.Get(TypeSymbol.Int32, 2);
        var sameRank2 = TypeSymbol.FromClrType(typeof(int[,]));
        var rank3 = TypeSymbol.FromClrType(typeof(int[,,]));
        var rank32 = RectangularArrayTypeSymbol.Get(TypeSymbol.Int32, 32);

        Assert.Same(rank2, sameRank2);
        Assert.NotSame(rank2, rank3);
        Assert.Equal(typeof(int[,]), rank2.ClrType);
        Assert.Equal("[,]int32", SymbolDisplay.ToTypeDisplayString(rank2));
        Assert.Equal("[,,]int32", SymbolDisplay.ToTypeDisplayString(rank3));
        Assert.Equal(32, rank32.ClrType.GetArrayRank());
    }

    [Fact]
    public void RectangularAndSzArrays_DoNotConvertAcrossRanks()
    {
        var diagnostics = Bind(
            """
            package P
            func NeedRect(value [,]int32) {}
            func NeedSlice(value []int32) {}
            NeedRect([]int32{1})
            NeedSlice([1, 1]int32)
            """);

        Assert.Equal(2, diagnostics.Count(diagnostic => diagnostic.IsError));
    }

    [Fact]
    public void NullableRectangularArray_RequiresNarrowingOrNullConditionalIndexing()
    {
        var diagnostics = Bind(
            """
            package P
            func Use(maybe [,]?int32) {
                let value = maybe[0, 0]
                maybe[0, 0] = 1
                let first = maybe[0]
                maybe[0] = 2
            }
            """);

        Assert.Equal(4, diagnostics.Count(diagnostic => diagnostic.Id == "GS0116"));
    }

    [Fact]
    public void ExpressionTreeRectangularInitializer_ReportsExistingRestrictionDiagnostic()
    {
        var diagnostics = Bind(
            """
            package P
            import System
            import System.Linq.Expressions
            let factory Expression[Func[[,]int32]] = () -> [1, 2]int32{3, 4}
            """);

        Assert.Contains(
            diagnostics,
            diagnostic => diagnostic.Id == "GS0473"
                && diagnostic.Message.Contains("rectangular-array initializer", StringComparison.Ordinal));
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
        => EmittedOracle.Evaluate(source).Diagnostics;
}
