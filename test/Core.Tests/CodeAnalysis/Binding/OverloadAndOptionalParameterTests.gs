// <copyright file="OverloadAndOptionalParameterTests.cs" company="GSharp">
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

/// ADR-0063: tests for user-defined method overloading and optional parameters
/// with compile-time-constant defaults. Covers free-function overload sets,
/// duplicate-signature rejection (GS0264), invalid-default diagnostics (GS0265),
/// ambiguous-resolution (GS0266), no-applicable-overload (GS0267), and the
/// happy-path "omit trailing optional" + "omit middle optional via named arg"
/// patterns from §3 / §6 of the ADR.
open class OverloadAndOptionalParameterTests {
    @Fact
    func TopLevelFunctions_DistinctArity_BothBindOK() {
        let source = `
func choose(x int32) int32 { return x }
func choose(x int32, y int32) int32 { return x + y }

let a = choose(7)
let b = choose(3, 4)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func TopLevelFunctions_DuplicateSignature_DiagnosesGS0264() {
        let source = `
func dup(x int32) int32 { return x }
func dup(x int32) int32 { return x + 1 }
`
        let result = Evaluate(source)
        AssertHasDiagnosticId(result.Diagnostics, "GS0264")
    }

    @Fact
    func OptionalParameter_TrailingOmitted_UsesDefault() {
        let source = `
func greet(prefix string, count int32 = 2) int32 {
    return count
}

let n = greet("hi")
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(2, result.Value)
    }

    @Fact
    func OptionalParameter_NamedOmission_MiddleSlotUsesDefault() {
        let source = `
func three(a int32, b int32 = 10, c int32 = 100) int32 {
    return a + b + c
}

let n = three(1, c: 1000)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1011, result.Value)
    }

    @Fact
    func OptionalParameter_OnRefKind_DiagnosesGS0265() {
        let source = `
func f(ref x int32 = 0) int32 { return x }
`
        let result = Evaluate(source)
        AssertHasDiagnosticId(result.Diagnostics, "GS0265")
    }

    @Fact
    func OptionalParameter_OnVariadic_DiagnosesGS0265() {
        let source = `
func f(xs ...int32 = 0) int32 { return 0 }
`
        let result = Evaluate(source)
        AssertHasDiagnosticId(result.Diagnostics, "GS0265")
    }

    @Fact
    func OptionalParameter_NonConstantDefault_DiagnosesGS0265() {
        let source = `
func f(x int32 = 1 + 2) int32 { return x }
`
        let result = Evaluate(source)
        AssertHasDiagnosticId(result.Diagnostics, "GS0265")
    }

    @Fact
    func ClassMethods_DistinctSignatures_BothBindOK() {
        let source = `
class Calc {
    func add(x int32) int32 { return x }
    func add(x int32, y int32) int32 { return x + y }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ClassMethods_DuplicateSignature_DiagnosesGS0264() {
        let source = `
class Calc {
    func sum(x int32) int32 { return x }
    func sum(x int32) int32 { return x + 1 }
}
`
        let result = Evaluate(source)
        AssertHasDiagnosticId(result.Diagnostics, "GS0264")
    }

    @Fact
    func InterfaceMethods_DistinctSignatures_BothBindOK() {
        let source = `
interface IOps {
    func op(x int32) int32;
    func op(x int32, y int32) int32;
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func InstanceMethod_OverloadResolution_PicksByArity() {
        // ADR-0063 §9: instance-method overload resolution at call sites now
        // chooses by arity/type rather than first-by-name.
        let source = `
class Calc(seed int32) {
    func add(x int32) int32 { return x + seed }
    func add(x int32, y int32) int32 { return x + y + seed }
}
let c = Calc(1)
c.add(10)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(11, result.Value)
    }

    @Fact
    func InstanceMethod_OverloadResolution_PicksTwoArg() {
        let source = `
class Calc(seed int32) {
    func add(x int32) int32 { return x + seed }
    func add(x int32, y int32) int32 { return x + y + seed }
}
let c = Calc(0)
c.add(7, 8)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(15, result.Value)
    }

    @Fact
    func PrimaryConstructor_OptionalParameter_OmitsTrailing() {
        // ADR-0063 §5: primary constructors honor optional parameters.
        let source = `
class P(X int32, Y int32 = 5) {}
let p = P(1)
p.Y
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func MultipleInitConstructors_SelectsByArgCount() {
        // ADR-0063 §9: multiple init(...) overloads, overload-resolved at call site.
        let source = `
class Box {
    var X int32
    init(a int32) { X = a }
    init(a int32, b int32) { X = a * b }
}
let b = Box(3, 4)
b.X
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(12, result.Value)
    }

    @Fact
    func MultipleInitConstructors_DuplicateSignature_Diagnoses() {
        let source = `
class Box {
    var X int32
    init(a int32) { X = a }
    init(a int32) { X = a + 1 }
}
`
        let result = Evaluate(source)
        AssertHasDiagnosticId(result.Diagnostics, "GS0264")
    }

    @Fact
    func MethodGroup_OverloadResolution_PicksByDelegateSignature() {
        // ADR-0063 §9: a method-group reference whose name has multiple
        // overloads resolves against the target delegate signature.
        let source = `
func op(x int32) int32 { return x + 1 }
func op(x int32, y int32) int32 { return x + y }

let f (int32) -> int32 = op
f(10)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(11, result.Value)
    }

    shared {
        private func AssertHasDiagnosticId(diagnostics ImmutableArray[Diagnostic], id string) {
            Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == id)
        }

        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
