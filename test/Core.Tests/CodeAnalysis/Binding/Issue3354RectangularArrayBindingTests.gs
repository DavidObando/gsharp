// <copyright file="Issue3354RectangularArrayBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Symbols.Display
import GSharp.Tests
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// Binding, identity, and diagnostic coverage for issue #3354.
open class Issue3354RectangularArrayBindingTests {
    @Fact
    func AllocationReadWriteFieldsParametersReturnsAndGenerics_Bind() {
        let diagnostics = Bind(`package P
func Echo[T](value [,]T) [,]T { return value }
func Set(value [,]int32, row int32, column int32) {
    value[row, column] = 42
}
var field [,]int32 = [2, 3]int32
let returned = Echo[int32](field)
Set(returned, 1, 2)`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func IndexArityMismatch_ReportsGs0527() {
        Assert.Contains(Bind(`package P
let value = [2, 3]int32
let item = value[0]
`), (diagnostic Diagnostic) -> diagnostic.Id == "GS0527")
    }

    @Fact
    func WriteAndCompoundIndexArityMismatch_ReportGs0527() {
        let diagnostics = Bind(`package P
var value = [2, 3]int32
value[0] = 1
value[0] += 1
`)
        Assert.Equal(2, diagnostics.Count((diagnostic Diagnostic) -> diagnostic.Id == "GS0527"))
    }

    @Fact
    func NonIntegralDimensionAndIndex_ReportConversionErrors() {
        let diagnostics = Bind(`package P
let value = [true, 2]int32
let other = [1, 1]int32
let item = other[false, 0]
`)
        Assert.True(diagnostics.Count((diagnostic Diagnostic) -> diagnostic.IsError) >= 2)
    }

    @Fact
    func RankAboveClrLimit_ReportsGs0528() {
        let dimensions = string.Join(", ", [33]string)
        Assert.Contains(Bind((`package P
var value [` + "$dimensions" + `]int32
`)), (diagnostic Diagnostic) -> diagnostic.Id == "GS0528")
    }

    @Fact
    func InitializerWithRuntimeDimensions_ReportsGs0529() {
        Assert.Contains(Bind(`package P
let rows = 2
let value = [rows, 2]int32{1, 2, 3, 4}
`), (diagnostic Diagnostic) -> diagnostic.Id == "GS0529")
    }

    @Fact
    func InitializerElementCountMismatch_ReportsGs0530() {
        Assert.Contains(Bind(`package P
let value = [2, 3]int32{1, 2, 3}
`), (diagnostic Diagnostic) -> diagnostic.Id == "GS0530")
    }

    @Fact
    func Symbols_IncludeRankInIdentityDisplayAndClrProjection() {
        let rank2 = RectangularArrayTypeSymbol.Get(TypeSymbol.Int32, 2)
        let sameRank2 = TypeSymbol.FromClrType(typeof([,]int32))
        let rank3 = TypeSymbol.FromClrType(typeof([, ,]int32))
        let rank32 = RectangularArrayTypeSymbol.Get(TypeSymbol.Int32, 32)
        Assert.Same(rank2, sameRank2)
        Assert.NotSame(rank2, rank3)
        Assert.Equal(typeof([,]int32), rank2.ClrType)
        Assert.Equal("[,]int32", SymbolDisplay.ToTypeDisplayString(rank2))
        Assert.Equal("[,,]int32", SymbolDisplay.ToTypeDisplayString(rank3))
        Assert.Equal(32, rank32.ClrType!!.GetArrayRank())
    }

    @Fact
    func RectangularAndSzArrays_DoNotConvertAcrossRanks() {
        let diagnostics = Bind(`package P
func NeedRect(value [,]int32) {}
func NeedSlice(value []int32) {}
NeedRect([]int32{1})
NeedSlice([1, 1]int32)`)
        Assert.Equal(2, diagnostics.Count((diagnostic Diagnostic) -> diagnostic.IsError))
    }

    @Fact
    func NullableRectangularArray_RequiresNarrowingOrNullConditionalIndexing() {
        let diagnostics = Bind(`package P
func Use(maybe [,]?int32) {
    let value = maybe[0, 0]
    maybe[0, 0] = 1
    let first = maybe[0]
    maybe[0] = 2
}`)
        Assert.Equal(4, diagnostics.Count((diagnostic Diagnostic) -> diagnostic.Id == "GS0116"))
    }

    @Fact
    func ExpressionTreeRectangularInitializer_ReportsExistingRestrictionDiagnostic() {
        let diagnostics = Bind(`package P
import System
import System.Linq.Expressions
let factory Expression[Func[[,]int32]] = () -> [1, 2]int32{3, 4}`)
        Assert.Contains(
            diagnostics,
            (diagnostic Diagnostic) -> diagnostic.Id == "GS0473" && diagnostic.Message.Contains(
                "rectangular-array initializer",
                StringComparison.Ordinal
            )
        )
    }

    shared {
        private func Bind(source string) ImmutableArray[Diagnostic] -> EmittedOracle.Evaluate(source).Diagnostics
    }
}
