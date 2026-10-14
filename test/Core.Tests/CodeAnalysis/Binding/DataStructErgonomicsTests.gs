// <copyright file="DataStructErgonomicsTests.cs" company="GSharp">
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
import Xunit

/// Phase 7.3 — data-struct copy, with-expression, and deconstruction ergonomics.
open class DataStructErgonomicsTests {
    @Fact
    func Copy_NoOverrides_YieldsEqualValue() {
        let result = Evaluate(PointPrelude + `
let p = Point{x: 1, y: 2}
let q = p.copy()
p == q
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func Copy_OneOverride_ReplacesOneField() {
        let result = Evaluate(PointPrelude + `
let p = Point{x: 1, y: 2}
let q = p.copy(x: 10)
q.x + q.y
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(12, result.Value)
    }

    @Fact
    func Copy_AllOverrides_ReplacesAllFields() {
        let result = Evaluate(PointPrelude + `
let p = Point{x: 1, y: 2}
let q = p.copy(x: 10, y: 20)
q.x + q.y
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(30, result.Value)
    }

    @Fact
    func With_OneOverride_MatchesCopySemantics() {
        let result = Evaluate(PointPrelude + `
let p = Point{x: 1, y: 2}
let q = p.copy(x: 10)
let r = p with { x = 10 }
q == r
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func With_NonDataStruct_Diagnosed() {
        let result = Evaluate(`
struct Point {
    var x int32
    var y int32
}
let p = Point{x: 1, y: 2}
p with { x = 10 }
`)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func Copy_NonDataStruct_Diagnosed() {
        let result = Evaluate(`
struct Point {
    var x int32
    var y int32
}
let p = Point{x: 1, y: 2}
p.copy(x: 10)
`)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func PositionalDeconstruction_BindsFieldsInDeclarationOrder() {
        let result = Evaluate(PointPrelude + `
let p = Point{x: 3, y: 4}
let (a, b) = p
a * 10 + b
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(34, result.Value)
    }

    @Fact
    func MutablePositionalDeconstruction_BindsFieldsInDeclarationOrder() {
        let result = Evaluate(PointPrelude + `
let p = Point{x: 3, y: 4}
var (a, b) = p
a = 5
a * 10 + b
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(54, result.Value)
    }

    @Fact
    func NamedDeconstruction_BindsFieldsByName() {
        let result = Evaluate(PointPrelude + `
let p = Point{x: 3, y: 4}
let { x = a, y = b } = p
a * 10 + b
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(34, result.Value)
    }

    @Fact
    func NamedDeconstruction_ReorderedNames_BindByName() {
        let result = Evaluate(PointPrelude + `
let p = Point{x: 3, y: 4}
let { y = first, x = second } = p
first * 10 + second
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(43, result.Value)
    }

    @Fact
    func NamedDeconstruction_UnknownField_Diagnosed() {
        let result = Evaluate(PointPrelude + `
let p = Point{x: 3, y: 4}
let { z = a } = p
a
`)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func NamedDeconstruction_DuplicateField_Diagnosed() {
        let result = Evaluate(PointPrelude + `
let p = Point{x: 3, y: 4}
let { x = a, x = b } = p
a
`)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func PositionalDeconstruction_WrongArity_Diagnosed() {
        let result = Evaluate(PointPrelude + `
let p = Point{x: 3, y: 4}
let (a) = p
a
`)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func Copy_ReceiverWithSideEffect_EvaluatesOnce() {
        let result = Evaluate(PointPrelude + `
var hits = 0
func make() Point {
    hits = hits + 1
    return Point{x: hits, y: 2}
}
let q = make().copy(x: 10)
hits
`)
        // GS0286 (TLS must be contiguous, ADR-0066 D5) fires as a warning on
        // this helper-between-TLS layout; the test exercises emitted-oracle
        // correctness, not the layout warning, so filter it.
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id != "GS0286")
        Assert.Equal(1, result.Value)
    }

    @Fact
    func With_ReceiverWithSideEffect_EvaluatesOnce() {
        let result = Evaluate(PointPrelude + `
var hits = 0
func make() Point {
    hits = hits + 1
    return Point{x: hits, y: 2}
}
let q = make() with { x = 10 }
hits
`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id != "GS0286")
        Assert.Equal(1, result.Value)
    }

    shared {
        private const PointPrelude string = `
data struct Point {
    var x int32
    var y int32
}
`

        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
