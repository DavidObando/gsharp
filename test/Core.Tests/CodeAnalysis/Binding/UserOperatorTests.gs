// <copyright file="UserOperatorTests.cs" company="GSharp">
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

/// Stream D — user-defined operator overloads on GSharp struct types via the
/// `func (a T) operator +(...)` receiver-form syntax.
open class UserOperatorTests {
    @Fact
    func StructPlusOperator_BinaryAddition_BindsAndEvaluates() {
        let source = `
struct Vector2 {
    var X int32
    var Y int32
}

func (a Vector2) operator +(b Vector2) Vector2 {
    return Vector2{X: a.X + b.X, Y: a.Y + b.Y}
}

var p = Vector2{X: 1, Y: 2}
var q = Vector2{X: 3, Y: 4}
var r = p + q
var first = r.X
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(4, result.Value)
    }

    @Fact
    func StructUnaryNegation_BindsAndEvaluates() {
        let source = `
struct Vector2 {
    var X int32
    var Y int32
}

func (a Vector2) operator -() Vector2 {
    return Vector2{X: -a.X, Y: -a.Y}
}

var p = Vector2{X: 3, Y: 4}
var r = -p
var negX = r.X
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(-3, result.Value)
    }

    @Fact
    func StructEqualityOperator_OverridesDefault() {
        // Two Vector2 values whose X+Y sums match should compare equal under a
        // user-defined op_Equality even when individual fields differ.
        let source = `
struct Vector2 {
    var X int32
    var Y int32
}

func (a Vector2) operator ==(b Vector2) bool {
    return a.X + a.Y == b.X + b.Y
}

func (a Vector2) operator !=(b Vector2) bool {
    return a.X + a.Y != b.X + b.Y
}

var p = Vector2{X: 1, Y: 4}
var q = Vector2{X: 2, Y: 3}
var eq = p == q
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func InheritedBinaryOperator_DeclaredOnOpenBase_BindsThroughDerived() {
        // ADR-0112 A8: a user operator declared on an open base class must be
        // found when the operands are a derived instance — the binder walks the
        // base chain via TypeMemberModel.TryGetMethodIncludingInherited.
        let source = `
open class OpBaseVec {
    var X int32
}

func (a OpBaseVec) operator +(b OpBaseVec) int32 {
    return a.X + b.X
}

class OpDerivedVec : OpBaseVec {
}

var p = OpDerivedVec{X: 5}
var q = OpDerivedVec{X: 7}
var sum = p + q
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(12, result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
