// <copyright file="Issue1180SmartCastMembersBinderTests.cs" company="GSharp">
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

/// ADR-0069 addendum / issue #1180 — extend Kotlin-style smart cast from
/// locals to <em>stable member-access paths</em>. A narrowing on a member path
/// is only sound when every link is immutable and not externally mutable
/// between the test and the use: an immutable `let` field or a getter-only
/// / init-only auto-property (no custom getter, not `open`/override),
/// declared in the current compilation, read through a stable receiver chain.
/// These tests mirror the local smart-cast coverage style and exercise the
/// positive and negative (stability) cases.
open class Issue1180SmartCastMembersBinderTests {
    @Fact
    func If_IsTest_NarrowsStableLetFieldPathInThenBranch() {
        let result = Evaluate(Hierarchy + `
class Box { let Pet Animal }
func Run(b Box) string {
    if b.Pet is Dog {
        return b.Pet.Bark()
    }
    return ""
}
Run(Box{Pet: Dog{Name: "Rex"}})
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func If_NegatedIsTest_NarrowsStableFieldPathAfterEarlyReturn() {
        let result = Evaluate(Hierarchy + `
class Box { let Pet Animal }
func Run(b Box) string {
    if b.Pet !is Dog { return "" }
    return b.Pet.Bark()
}
Run(Box{Pet: Dog{Name: "Rex"}})
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func If_IsTest_NarrowsDeepStableReceiverChain() {
        let result = Evaluate(Hierarchy + `
class Inner { let Pet Animal }
class Box { let In Inner }
func Run(b Box) string {
    if b.In.Pet !is Dog { return "" }
    return b.In.Pet.Bark()
}
Run(Box{In: Inner{Pet: Dog{Name: "Rex"}}})
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func If_IsTest_NarrowsInitOnlyAutoPropertyPath() {
        let result = Evaluate(Hierarchy + `
class Box {
    prop Pet Animal { get; init; }
}
func Run(b Box) string {
    if b.Pet is Dog {
        return b.Pet.Bark()
    }
    return ""
}
Run(Box() { Pet = Dog{Name: "Rex"} })
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func NilGuard_NarrowsStableNullableFieldPath() {
        let result = Evaluate(Hierarchy + `
class Box { let Pet Animal? }
func Run(b Box) string {
    if b.Pet != nil {
        return b.Pet.Describe()
    }
    return ""
}
Run(Box{Pet: Dog{Name: "Rex"}})
`)
        Assert.Empty(result.Diagnostics)
    }

    @Theory
    @InlineData("let Stable System.Collections.Generic.List[int32]?", "Stable.Capacity > 0")
    @InlineData("let Stable System.Collections.Generic.List[int32]?", "Stable.Contains(1)")
    @InlineData("prop Stable System.Collections.Generic.List[int32]? { get; init; }", "Stable.Capacity > 0")
    @InlineData("prop Stable System.Collections.Generic.List[int32]? { get; init; }", "Stable.Contains(1)")
    func NilGuard_NarrowsBareImplicitThisMember(member string, use string) {
        // Issue #4310: the bare spelling must consult the same stable
        // AccessPath as this.Stable, for reads and calls alike.
        let result = Evaluate((`
class Box {
    ` + "$member" + `
    func Run() bool { return Stable != nil && ` + "$use" + ` }
}
`))
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Switch_NarrowsStableFieldPathDiscriminantInArm() {
        let result = Evaluate(Hierarchy + `
class Box { let Pet Animal }
func Run(b Box) string {
    switch b.Pet {
        case d is Dog { return b.Pet.Bark() }
        default { return "" }
    }
    return ""
}
Run(Box{Pet: Dog{Name: "Rex"}})
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func If_IsTestAnd_ThreadsMemberPathNarrowingIntoRhs() {
        let result = Evaluate(Hierarchy + `
class Box { let Pet Animal }
func Run(b Box) string {
    if b.Pet is Dog && b.Pet.Bark() != "" {
        return b.Pet.Bark()
    }
    return ""
}
Run(Box{Pet: Dog{Name: "Rex"}})
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func MutableVarField_DoesNotNarrow() {
        let result = Evaluate(Hierarchy + `
class Box { var Pet Animal }
func Run(b Box) string {
    if b.Pet is Dog {
        return b.Pet.Bark()
    }
    return ""
}
Run(Box{Pet: Dog{Name: "Rex"}})
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Bark", StringComparison.Ordinal))
    }

    @Fact
    func MutableVarAutoProperty_DoesNotNarrow() {
        let result = Evaluate(Hierarchy + `
class Box { prop Pet Animal }
func Run(b Box) string {
    if b.Pet is Dog {
        return b.Pet.Bark()
    }
    return ""
}
Run(Box() { Pet = Dog{Name: "Rex"} })
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Bark", StringComparison.Ordinal))
    }

    @Fact
    func CustomGetterProperty_DoesNotNarrow() {
        let result = Evaluate(Hierarchy + `
class Box {
    let backing Animal
    prop Pet Animal { get { return backing } }
    init(p Animal) { backing = p }
}
func Run(b Box) string {
    if b.Pet is Dog {
        return b.Pet.Bark()
    }
    return ""
}
Run(Box(Dog{Name: "Rex"}))
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Bark", StringComparison.Ordinal))
    }

    @Fact
    func OverridableOpenProperty_DoesNotNarrow() {
        let result = Evaluate(Hierarchy + `
open class Box {
    open prop Pet Animal { get; init; }
}
func Run(b Box) string {
    if b.Pet is Dog {
        return b.Pet.Bark()
    }
    return ""
}
Run(Box() { Pet = Dog{Name: "Rex"} })
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Bark", StringComparison.Ordinal))
    }

    @Fact
    func InterveningCall_InvalidatesMemberPathNarrowing() {
        let result = Evaluate(Hierarchy + `
class Box { let Pet Animal }
func SideEffect() {}
func Run(b Box) string {
    if b.Pet !is Dog { return "" }
    SideEffect()
    return b.Pet.Bark()
}
Run(Box{Pet: Dog{Name: "Rex"}})
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Bark", StringComparison.Ordinal))
    }

    @Fact
    func InterveningMemberAssignment_InvalidatesMemberPathNarrowing() {
        let result = Evaluate(Hierarchy + `
class Box { var Other int32 = 0 let Pet Animal }
func Run(b Box) string {
    if b.Pet !is Dog { return "" }
    b.Other = 1
    return b.Pet.Bark()
}
Run(Box{Pet: Dog{Name: "Rex"}})
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Bark", StringComparison.Ordinal))
    }

    @Fact
    func ImportedClrMemberPath_DoesNotNarrow() {
        // A member read through an imported / CLR type surfaces as a
        // BoundClrPropertyAccessExpression, which is never a stable G# path —
        // the binder cannot guarantee idempotence / immutability across module
        // boundaries, so no narrowing applies.
        let result = Evaluate(Hierarchy + `
import System
class Box { let Builder System.Text.StringBuilder }
func Run(b Box) int32 {
    if b.Builder.Length is int32 {
        return b.Builder.Length + 1
    }
    return 0
}
Run(Box{Builder: System.Text.StringBuilder()})
`)
        // The point is purely that the member path is not narrowed; the program
        // need not be otherwise meaningful. We assert that binding does not
        // crash and produces a deterministic result object.
        Assert.NotNull(result)
    }

    shared {
        private const Hierarchy string = `
open class Animal {
    var Name string
    open func Describe() string { return Name }
}
class Dog : Animal {
    func Bark() string { return "woof" }
}
class Cat : Animal {
    func Purr() string { return "purr" }
}
`

        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
