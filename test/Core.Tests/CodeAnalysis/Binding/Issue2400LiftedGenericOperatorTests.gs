// <copyright file="Issue2400LiftedGenericOperatorTests.cs" company="GSharp">
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
import System.Linq
import Xunit

open class Issue2400LiftedGenericOperatorTests {
    @Fact
    func ClosedGenericNullableEquality_EvaluatesLiftedNullSemantics() {
        let result = Evaluate(`struct Box[T] {
    var Value T
    var Rank int32
}

func (left Box[T]) operator ==(right Box[T]) bool -> left.Rank == right.Rank

let present Box[string]? = Box[string]{Value: "a", Rank: 7}
let same Box[string]? = Box[string]{Value: "b", Rank: 7}
let missing Box[string]? = nil
present == same && !(present == missing) && missing == missing`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.True(bool(result.Value))
    }

    @Fact
    func ClosedGenericNullableOrdering_EvaluatesPresentAndMissingOperands() {
        let result = Evaluate(`struct Box[T] {
    var Value T
    var Rank int32
}

func (left Box[T]) operator <(right Box[T]) bool -> left.Rank < right.Rank

let low Box[int32]? = Box[int32]{Value: 1, Rank: 1}
let high Box[int32]? = Box[int32]{Value: 2, Rank: 2}
let missing Box[int32]? = nil
low < high && !(low < missing)`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.True(bool(result.Value))
    }

    @Fact
    func ClosedGenericNullableArithmetic_EvaluatesAndPropagatesNil() {
        let present = Evaluate(`struct Box[T] {
    var Value T
    var Rank int32
}

func (left Box[T]) operator +(right Box[T]) int32 -> left.Rank + right.Rank

let left Box[string]? = Box[string]{Value: "a", Rank: 20}
let right Box[string]? = Box[string]{Value: "b", Rank: 22}
(left + right)!!`)
        Assert.Empty(present.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(42, present.Value)
        let missing = Evaluate(`struct Box[T] {
    var Value T
    var Rank int32
}

func (left Box[T]) operator +(right Box[T]) int32 -> left.Rank + right.Rank

let left Box[string]? = Box[string]{Value: "a", Rank: 20}
let missing Box[string]? = nil
left + missing`)
        Assert.Empty(missing.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Null(missing.Value)
    }

    @Fact
    func ClosedGenericNonNullableOperator_UsesSubstitutedSignature() {
        let result = Evaluate(`struct Box[T] {
    var Value T
    var Rank int32
}

func (left Box[T]) operator +(right Box[T]) int32 -> left.Rank + right.Rank

let left = Box[string]{Value: "a", Rank: 20}
let right = Box[string]{Value: "b", Rank: 22}
left + right`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(42, result.Value)
    }

    @Fact
    func DifferentClosedGenericOperands_DoNotBindToOneInstantiation() {
        let result = Evaluate(`struct Box[T] {
    var Value T
}

func (left Box[T]) operator ==(right Box[T]) bool -> true

let text Box[string]? = Box[string]{Value: "a"}
let number Box[int32]? = Box[int32]{Value: 1}
text == number`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.IsError)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
