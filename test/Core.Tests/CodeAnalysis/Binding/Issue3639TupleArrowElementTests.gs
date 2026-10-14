// <copyright file="Issue3639TupleArrowElementTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Tests
import Xunit

/// Issue #3639 — end-to-end coverage for tuple types with parenthesized
/// arrow-function elements: `((int32) -> int32, (int32) -> int32)`.
/// Witness of discrimination: before the fix every declared type below was a
/// GS0005 parse error ("Unexpected token <CommaToken>") because the parser
/// committed the leading `((` to the ADR-0137 parenthesized-arrow form.
open class Issue3639TupleArrowElementTests {
    @Fact
    func TupleOfArrowFunctions_DeclaredReturnType_DeconstructAndInvoke() {
        let result = EmittedOracle.Evaluate(`
func mk() ((int32) -> int32, (int32) -> int32) {
    return ((x int32) -> x + 1, (x int32) -> x * 2)
}

let (a, b) = mk()
a(1) + b(3)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(8, result.Value)
    }

    @Fact
    func TupleOfZeroArgArrowFunctions_DeclaredReturnType() {
        let result = EmittedOracle.Evaluate(`
func mk() (() -> int32, () -> int32) {
    return (() -> 10, () -> 32)
}

let (a, b) = mk()
a() + b()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func TupleWithArrowElement_LocalDeclaration_MixedWithPlainType() {
        let result = EmittedOracle.Evaluate(`
let t ((int32) -> int32, int32) = ((x int32) -> x * x, 6)
let (f, n) = t
f(n)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(36, result.Value)
    }

    @Fact
    func NamedTupleElements_WithArrowElementTypes_AccessByName() {
        let result = EmittedOracle.Evaluate(`
func mk() (f (int32) -> int32, g () -> int32) {
    return ((x int32) -> x - 1, () -> 7)
}

let t = mk()
let f = t.f
let g = t.g
f(10) + g()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(16, result.Value)
    }
}
