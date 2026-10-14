// <copyright file="Issue1923PatternMatchingSeamsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import Xunit

/// Issue #1923: five narrow pattern-matching gaps found by the grid app G04
/// conformance build-out (each with a passing sibling, so these are seams,
/// not wholesale missing features).
/// 1. A boxed-constant equality (`answer == 42` where `answer` is `object`) previously reported GS0129
/// because (cref:GSharp.Core.CodeAnalysis.Binding.BoundBinaryOperator) only registers the homogeneous
/// `object == object` arm; there was no boxing-conversion adaptation for a non-`object` operand, unlike
/// the existing integer-literal / numeric-widening adaptations. The comparison uses object reference
/// identity, so separately boxed equal values are not equal.
/// 2. A property pattern (`{ City: "x" }`) against a nullable CLASS-typed subject (`Address?`)
/// previously reported GS0172 because `PatternBinder.BindPropertyPattern` required the discriminant
/// itself to be a (cref:StructSymbol), rejecting the `NullableTypeSymbol` wrapper outright instead of
/// unwrapping it (a property pattern implicitly requires non-null, exactly like C#'s recursive-pattern
/// rule).
/// Sub-bug #3 in the issue ("no flow-narrowing after nil checks" on
/// `person.Address.City`) turned out to be correct, DOCUMENTED by-design
/// behavior (ADR-0069 "stable member-access paths" addendum): narrowing a
/// member-access path requires every link to be immutable/stable (a
/// `let` field or a getter-only, non-virtual property); a mutable
/// `var` field is intentionally excluded because it could change between
/// the nil check and the use. (cref:FlowNarrowing_MutableVarField_IsNotNarrowed_ByDesign)
/// documents that the mutable case correctly still requires a workaround,
/// while (cref:FlowNarrowing_ImmutableLetField_NarrowsAfterNilCheck)
/// proves the same shape narrows once the field is declared `let`
/// (matching the ADR's stable-path contract) — this is not a regression.
open class Issue1923PatternMatchingSeamsTests {
    @Fact
    func BoxedConstantEquality_UsesObjectReferenceIdentity() {
        let source = `
let answer object = 42
answer == 42
`
        // ADR-0045: the literal boxes into a new object, so reference
        // equality against the existing box is false.
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(false, result.Value)
    }

    @Fact
    func BoxedConstantEquality_FalseForMismatchedValue() {
        let source = `
let answer object = 41
answer == 42
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(false, result.Value)
    }

    @Fact
    func IsPattern_NonNullableClassSubject_Binds() {
        let source = `
class Foo { var X int32 }
func check(f Foo) bool { return f is Foo }
check(Foo{X: 1})
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func FlowNarrowing_ImmutableLetField_NarrowsAfterNilCheck() {
        // ADR-0069 addendum (issue #1180): a `let` (read-only) field is a
        // stable member-access link, so `p.Address != nil` narrows the
        // subsequent `p.Address.City` read — no explicit `!!`/cast needed.
        let source = `
class Address { var City string }
class Person { let Address Address? }
func getCity(p Person) string {
    if p.Address != nil {
        return p.Address.City
    }
    return "none"
}
getCity(Person{Address: Address{City: "here"}})
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("here", result.Value)
    }

    @Fact
    func FlowNarrowing_MutableVarField_IsNotNarrowed_ByDesign() {
        // By design (ADR-0069 addendum): a mutable `var` field is NOT a
        // stable link (it could be reassigned between the nil check and the
        // use, possibly from another thread), so `p.Address.City` still
        // reports GS0158 even after `p.Address != nil` — this is correct,
        // not the bug in issue #1923. The documented workaround (also used
        // by cs2gs's translation of the equivalent C#) is the non-null
        // assertion `p.Address!!.City`.
        let source = `
class Address { var City string }
class Person { var Address Address? }
func getCity(p Person) string {
    if p.Address != nil {
        return p.Address.City
    }
    return "none"
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("City", StringComparison.Ordinal))
    }

    @Fact
    func PropertyPattern_OnNullableSwitchSubject_Binds() {
        let source = `
class Address { var City string }
func check(a Address?) int32 {
    return switch a {
        case { City: "x" }: 1
        default: 0
    }
}
check(Address{City: "x"})
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    @Fact
    func PropertyPattern_OnNullSubject_FailsToMatch_RatherThanThrowing() {
        let source = `
class Address { var City string }
func check(a Address?) int32 {
    return switch a {
        case { City: "x" }: 1
        default: 0
    }
}
let none Address? = nil
check(none)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }

    @Fact
    func BoxedSubjectSwitch_OnNullableClassSubject_Binds() {
        let source = `
class Person { var Name string }
func check(p Person?) int32 {
    return switch p {
        case o is object: 1
        default: 0
    }
}
check(Person{Name: "x"})
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
