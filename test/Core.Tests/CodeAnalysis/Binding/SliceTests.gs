// <copyright file="SliceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Collections.Immutable
import Xunit

/// Phase 3.A.2 — variable-length slice types `[]T`, composite
/// literals, and indexing. ADR-0174 D13 retired the `len` /
/// `cap` / `append` built-ins: a slice's length is `.Length`,
/// the growable shape is `List[T]` + `Add`, and the retired
/// spellings report GS0566 naming that replacement.
open class SliceTests {
    @Fact
    func SliceLiteral_BindsAndEvaluates() {
        let result = Evaluate("var xs = []int32{10, 20, 30}\nxs[1]")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(20, result.Value)
    }

    @Fact
    func TypedSliceDeclaration_Works() {
        let result = Evaluate("var xs []int32 = []int32{1, 2, 3}\nxs[0] + xs[2]")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(4, result.Value)
    }

    @Fact
    func Len_OnSlice_ReturnsCount() {
        let result = Evaluate("var xs = []int32{1, 2, 3, 4}\nxs.Length")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(4, result.Value)
    }

    @Fact
    func Len_OnArray_ReturnsLength() {
        let result = Evaluate("var xs = [3]int32{1, 2, 3}\nxs.Length")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func Len_OnString_ReturnsLength() {
        let result = Evaluate("\"hello\".Length")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func Cap_IsRetired_ReportsGS0566() {
        // ADR-0174 D13: `cap` has no replacement — a slice is a fixed CLR
        // array whose capacity is its length.
        let diagnostics = Bind(`var xs = []int32{1, 2, 3}
cap(xs)
`)
        let diagnostic = Assert.Single(diagnostics)
        Assert.Equal("GS0566", diagnostic.Id)
        Assert.Contains("xs.Length", diagnostic.Message)
    }

    @Fact
    func Append_IsRetired_ReportsGS0566_NamingListAdd() {
        let diagnostics = Bind(`var xs = []int32{1, 2}
xs = append(xs, 3)
`)
        let diagnostic = Assert.Single(diagnostics)
        Assert.Equal("GS0566", diagnostic.Id)
        Assert.Contains("List[T]", diagnostic.Message)
        Assert.Contains("xs.Add(3)", diagnostic.Message)
    }

    @Fact
    func GrowableShape_IsListAdd() {
        let result = Evaluate(`import System.Collections.Generic
var xs = List[int32]()
xs.Add(10)
xs.Add(20)
xs.Add(30)
xs[0] + xs[1] + xs[2]`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(60, result.Value)
    }

    @Fact
    func StringSlice_LiteralIndexes() {
        let result = Evaluate("var ns = []string{\"a\", \"b\"}\nns[1]")
        Assert.Empty(result.Diagnostics)
        Assert.Equal("b", result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }

        private func Bind(source string) ImmutableArray[Diagnostic] -> Evaluate(source).Diagnostics
    }
}
