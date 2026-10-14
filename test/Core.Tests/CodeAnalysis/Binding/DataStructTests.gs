// <copyright file="DataStructTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import System.Linq
import Xunit

/// Emitted-oracle coverage for data struct.
/// Traceability: ADR-0029.
open class DataStructTests {
    @Fact
    func DataStruct_EqualValues_AreEqual() {
        let source = `
data struct Point {
    var X int32
    var Y int32
}

var p = Point{X: 1, Y: 2}
var q = Point{X: 1, Y: 2}
p == q
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func DataStruct_DifferentFieldValues_AreNotEqual() {
        let source = `
data struct Point {
    var X int32
    var Y int32
}

var p = Point{X: 1, Y: 2}
var q = Point{X: 1, Y: 3}
p != q
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func DataStruct_AssignmentCreatesEqualCopy() {
        let source = `
data struct Point {
    var X int32
    var Y int32
}

var p = Point{X: 5, Y: 7}
var q = p
q.X = 99
p == q
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(false, result.Value)
    }

    @Fact
    func PlainStruct_EqualityRejected() {
        let source = `
struct Point {
    var X int32
    var Y int32
}

var p = Point{X: 1, Y: 2}
var q = Point{X: 1, Y: 2}
p == q
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func DataStruct_DistinctTypes_EqualityRejected() {
        let source = `
data struct A {
    var V int32
}
data struct B {
    var V int32
}

var a = A{V: 1}
var b = B{V: 1}
a == b
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func DataStruct_NoFields_NoLongerDiagnosed() {
        // Issue #2363 / ADR-0029 amendment: a zero-field `data struct` was
        // previously unconditionally rejected (GS0104). It is now a
        // supported degenerate shape (needed to translate an empty C#
        // positional record/record struct) — see
        // Issue2363EmptyDataTypesTests for the full zero-field-support
        // regression suite.
        let source = `
data struct Empty {
}
0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func DataStruct_ToString_IncludesFieldValues() {
        let source = `
data struct Point {
    var X int32
    var Y int32
}

var p = Point{X: 3, Y: 4}
p
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.NotNull(result.Value)
        let rendered string? = result.Value!!.ToString()
        Assert.Equal("Point { X = 3, Y = 4 }", rendered)
    }

    @Fact
    func DataStruct_HashCode_StableForEqualValues() {
        let sym = BuildPoint(out var compilation)
        let p = StructValue(sym)
        p.Fields["X"] = 1
        p.Fields["Y"] = 2
        let q = StructValue(sym)
        q.Fields["X"] = 1
        q.Fields["Y"] = 2
        Assert.Equal(p.GetHashCode(), q.GetHashCode())
        Assert.True(p.Equals(q))
    }

    @Fact
    func DataStruct_ExplicitEqualsObject_ReportsGS0232() {
        // ADR-0029 / Issue #410: Equals/GetHashCode/ToString/op_Equality/
        // op_Inequality/Deconstruct are synthesized for data structs and
        // cannot be hand-written, so the structural contract stays
        // predictable.
        let source = `
data struct Point {
    var X int32
    var Y int32

    func Equals(other any) bool {
        return false
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0232")
    }

    @Fact
    func DataStruct_ExplicitGetHashCode_ReportsGS0232() {
        let source = `
data struct Point {
    var X int32
    var Y int32

    func GetHashCode() int32 {
        return 0
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0232")
    }

    @Fact
    func DataStruct_ExplicitDeconstruct_ReportsGS0232() {
        let source = `
data struct Point {
    var X int32
    var Y int32

    func Deconstruct() {
    }
}
0
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0232")
    }

    @Fact
    func DataClass_ExplicitEqualsObject_ReportsGS0232() {
        let source = `
open data class Point(X int32, Y int32) {
    func Equals(other any) bool {
        return false
    }
}
0
`
        let result = Evaluate(source)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0232")
        Assert.Contains("Data class 'Point' synthesizes member 'Equals'", diagnostic.Message, StringComparison.Ordinal)
    }

    shared {
        private func BuildPoint(out compilation Compilation) StructSymbol {
            let source = `
data struct Point {
    var X int32
    var Y int32
}
0
`
            // Binder-inspection helper (issue #3176 Phase 3b.2): bind via
            // EmittedOracle.CompileDiagnostics and inspect this Compilation's
            // bound state; nothing needs to run.
            let tree = SyntaxTree.Parse(SourceText.From(source))
            compilation = Compilation(tree)
            Assert.Empty(EmittedOracle.CompileDiagnostics(compilation))
            let sym = cast[StructSymbol](compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == "Point"))
            Assert.NotNull(sym)
            Assert.True(sym.IsData)
            return sym
        }

        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
