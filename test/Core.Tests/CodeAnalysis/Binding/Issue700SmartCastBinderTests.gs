// <copyright file="Issue700SmartCastBinderTests.cs" company="GSharp">
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
import Xunit

/// ADR-0069 / issue #700 — Kotlin-style smart cast (flow-sensitive type
/// narrowing on `is`/`!is`). Binder-level coverage for the
/// narrowing semantics: positive narrowing in the then-branch of an
/// `is` test, after-early-exit narrowing on `!is`, threading
/// through `&&`, and the rules under which the narrowing
/// is dropped (reassignment, fields/properties, mismatched receivers,
/// `||` branches).
open class Issue700SmartCastBinderTests {
    @Fact
    func If_IsTest_NarrowsParameterInThenBranch() {
        let result = Evaluate(AnimalHierarchy + `
func Run(a Animal) string {
    if a is Dog {
        return a.Bark()
    }
    return ""
}
Run(Dog{Name: "Rex"})
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func If_NegatedIsTest_NarrowsParameterAfterEarlyReturn() {
        let result = Evaluate(AnimalHierarchy + `
func Run(a Animal) string {
    if a !is Dog {
        return ""
    }
    return a.Bark()
}
Run(Dog{Name: "Rex"})
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func If_BangIsTest_EquivalentToParenthesizedNegation() {
        // `if a !is Dog` and `if !(a is Dog)` must produce the same
        // narrowing: after the early return, `a` is `Dog`.
        let result = Evaluate(AnimalHierarchy + `
func Run(a Animal) string {
    if !(a is Dog) {
        return ""
    }
    return a.Bark()
}
Run(Dog{Name: "Rex"})
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func If_IsTestAndCondition_NarrowsInsideAndRhs() {
        // `if a is Dog && flag` — the right-hand side of `&&` binds with
        // `a` already narrowed to `Dog`. The then-branch sees `a` as
        // `Dog` as well.
        let result = Evaluate(AnimalHierarchy + `
func IsBarkable(d Dog) bool {
    return d.Name != ""
}
func Run(a Animal, flag bool) string {
    if a is Dog && IsBarkable(a) {
        return a.Bark()
    }
    return ""
}
Run(Dog{Name: "Rex"}, true)
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func If_IsTestOrCondition_DoesNotNarrow() {
        // Per ADR-0069: `||` does NOT narrow. In the then-arm we know
        // *one* of the operands held — neither alone forces `a` to be a
        // `Dog`, so `.Bark()` must be rejected.
        let result = Evaluate(AnimalHierarchy + `
func Run(a Animal, flag bool) string {
    if a is Dog || flag {
        return a.Bark()
    }
    return ""
}
Run(Cat{Name: "C"}, true)
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Bark", StringComparison.Ordinal))
    }

    @Fact
    func If_IsTest_NestedIsTestNarrowsFurther() {
        // Inside `if a is Dog`, `a` is `Dog`; inside an inner
        // `if a is Puppy`, it is further narrowed to `Puppy`, so
        // `Puppy`-only members resolve.
        let result = Evaluate(AnimalHierarchy + `
func Run(a Animal) string {
    if a is Dog {
        if a is Puppy {
            return a.Yip()
        }
        return a.Bark()
    }
    return ""
}
Run(Puppy{Name: "P"})
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func If_IsTest_OnGlobalVariable_DoesNotNarrow() {
        // ADR-0069: globals are not narrowed (another thread or another
        // top-level statement could mutate them). `.Bark()` must be
        // rejected on the declared `Animal` type.
        let result = Evaluate(AnimalHierarchy + `
let a Animal = Dog{Name: "R"}
if a is Dog {
    a.Bark()
}
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Bark", StringComparison.Ordinal))
    }

    @Fact
    func If_IsTest_OnInstanceField_DoesNotNarrow() {
        // ADR-0069: instance fields/properties are never narrowed —
        // aliasing or another thread could replace the field between
        // the test and the use.
        let result = Evaluate(AnimalHierarchy + `
class Box {
    var Pet Animal
}
func Run(b Box) string {
    if b.Pet is Dog {
        return b.Pet.Bark()
    }
    return ""
}
Run(Box{Pet: Dog{Name: "R"}})
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Bark", StringComparison.Ordinal))
    }

    @Fact
    func If_IsTest_ReassignmentDropsNarrowing() {
        // After `a = something`, the narrowing is dropped: the
        // second use of `.Bark()` must be rejected.
        let result = Evaluate(AnimalHierarchy + `
func Run(a Animal) string {
    var x = a
    if x is Dog {
        x = Cat{Name: "C"}
        return x.Bark()
    }
    return ""
}
Run(Dog{Name: "R"})
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Bark", StringComparison.Ordinal))
    }

    @Fact
    func If_IsTest_NarrowingDoesNotEscapeThenBranch() {
        // Outside the `if a is Dog` block, the narrowing is gone — a
        // bare `.Bark()` on the parameter must be rejected.
        let result = Evaluate(AnimalHierarchy + `
func Run(a Animal) string {
    if a is Dog {
    }
    return a.Bark()
}
Run(Dog{Name: "R"})
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Bark", StringComparison.Ordinal))
    }

    @Fact
    func If_IsTest_ReturnsValueAtNarrowedType() {
        // A narrowed read used as a return expression must convert
        // implicitly back to the declared (broader) type: `Dog` is
        // implicitly convertible to `Animal`.
        let result = Evaluate(AnimalHierarchy + `
func Run(a Animal) Animal {
    if a is Dog {
        return a
    }
    return a
}
Run(Dog{Name: "R"})
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func If_IsTest_OnNonReferenceVariable_NoNarrowing() {
        // Smart-casting an `int32` to itself is a no-op; the binder
        // should not fail and the program should evaluate.
        let result = Evaluate(`
func Run(n int32) int32 {
    if n is int32 {
        return n + 1
    }
    return n
}
Run(41)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func If_NestedIsTest_AfterEarlyExit_NarrowsRestOfMethod() {
        // `if a !is Dog { return }; if a is Puppy { ... }` — the
        // outer narrowing makes `a` a `Dog`; the inner test further
        // narrows to `Puppy`.
        let result = Evaluate(AnimalHierarchy + `
func Run(a Animal) string {
    if a !is Dog {
        return ""
    }
    if a is Puppy {
        return a.Yip()
    }
    return a.Bark()
}
Run(Puppy{Name: "P"})
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func If_IsTest_NarrowingComposesWithNilGuard() {
        // `if s != nil && s is string` — by the time we reach the
        // `is` test on the right of `&&`, `s` has been narrowed
        // to non-nullable `string` by the nil-guard. The combined
        // narrowing must not break either axis.
        let result = Evaluate(`
func Run(s string?) int32 {
    if s != nil && s is string {
        return s.Length
    }
    return 0
}
Run("hi")
`)
        Assert.Empty(result.Diagnostics)
    }

    shared {
        private const AnimalHierarchy string = `
open class Animal {
    var Name string
    open func Describe() string { return Name }
}
open class Dog : Animal {
    override func Describe() string { return "Dog" }
    func Bark() string { return "woof" }
}
class Cat : Animal {
    override func Describe() string { return "Cat" }
    func Purr() string { return "purr" }
}
class Puppy : Dog {
    func Yip() string { return "yip" }
}
`

        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
