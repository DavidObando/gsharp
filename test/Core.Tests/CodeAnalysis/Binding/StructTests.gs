// <copyright file="StructTests.cs" company="GSharp">
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

/// Emitted-oracle coverage for struct.
open class StructTests {
    @Fact
    func StructLiteral_ReadFields() {
        let source = `
struct Point {
    var X int32
    var Y int32
}

var p = Point{X: 3, Y: 4}
p.X + p.Y
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func StructLiteral_PartialInitDefaultsZero() {
        let source = `
struct Point {
    var X int32
    var Y int32
}

var p = Point{X: 5}
p.Y
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }

    @Fact
    func StructLiteral_EmptyLiteralZeroes() {
        let source = `
struct Point {
    var X int32
    var Y int32
}

var p = Point{}
p.X + p.Y
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }

    @Fact
    func StructFieldAssignment_Mutates() {
        let source = `
struct Point {
    var X int32
    var Y int32
}

var p = Point{X: 1, Y: 2}
p.X = 10
p.X
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(10, result.Value)
    }

    @Fact
    func StructAssignment_HasValueSemantics() {
        let source = `
struct Point {
    var X int32
    var Y int32
}

var p = Point{X: 1, Y: 2}
var q = p
q.X = 99
p.X
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    @Fact
    func UnknownField_Diagnosed() {
        let source = `
struct Point {
    var X int32
}

var p = Point{X: 1}
p.Z
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func DuplicateFieldName_Diagnosed() {
        let source = `
struct Point {
    var X int32
    var X int32
}
0
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func DuplicateStructName_Diagnosed() {
        let source = `
struct Point {
    var X int32
}
struct Point {
    var Y int32
}
0
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
