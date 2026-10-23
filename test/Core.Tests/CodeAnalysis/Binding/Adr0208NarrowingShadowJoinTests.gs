// <copyright file="Adr0208NarrowingShadowJoinTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Tests
import System
import System.Collections.Generic
import System.Linq
import Xunit

/// ADR-0208 section 19, PR 1: the shadow join and the comparison mode. The
/// binder computes the section 9 join beside the current passes and reports
/// each disagreement with its row of section 16. Each test compiles a probe
/// of the ADR table as a library and checks the report.
open class Adr0208NarrowingShadowJoinTests {
    @Fact
    func ElseExit_IsRow1() {
        let report = Join(`package T
func Get() string? { return nil }
func Run() int32 {
    let s string? = Get()
    if s != nil { Console.WriteLine("y") } else { return 0 }
    return s.Length
}`)
        Assert.Equal([]string{"5|s|nil|string|R1"}, report)
    }

    @Fact
    func AssignmentInAnExitingBranch_IsRow2() {
        let report = Join(`package T
func Get() string? { return nil }
func Run(c bool) int32 {
    var s string? = Get()
    if s == nil { return 0 }
    if c {
        s = nil
        return -1
    }
    return s.Length
}`)
        Assert.Equal([]string{"6|s|nil|string|R2"}, report)
    }

    @Fact
    func NestedBareBlock_IsRow3() {
        let report = Join(`package T
func Get() string? { return nil }
func Run() int32 {
    var s string? = Get()
    {
        if s == nil { return 0 }
    }
    return s.Length
}`)
        Assert.Equal([]string{"5|s|nil|string|R3"}, report)
    }

    @Fact
    func SwitchArmsThatAssign_IsRow4() {
        let report = Join(`package T
func Run(k int32) int32 {
    var s string? = nil
    switch k {
        case 1 { s = "a" }
        case 2 { s = "bb" }
        default { return 0 }
    }
    return s.Length
}`)
        Assert.Equal([]string{"4|s|nil|string|R4"}, report)
    }

    @Fact
    func MemberPathFact_IsRow5() {
        let report = Join(`package T
open class Animal { var Name string = "" }
class Dog : Animal { func Bark() string { return "woof" } }
class Box {
    let Pet Animal?
    init(p Animal?) { Pet = p }
}
func Run2(b Box) string {
    if b.Pet is Dog { } else { return "" }
    return b.Pet.Bark()
}`)
        Assert.Equal([]string{"9|b.Pet|nil|Dog|R5"}, report)
    }

    @Fact
    func AGotoElsewhereInTheFunction_IsRow6() {
        let report = Join(`package T
func Get() string? { return nil }
func Run(c bool) int32 {
    var s string? = Get()
    if s == nil { s = "a" }
    if c { goto done }
    Console.WriteLine("x")
    done:
    return s.Length
}`)
        Assert.Equal([]string{"5|s|nil|string|R6"}, report)
    }

    @Fact
    func SiblingRefinementsJoinToTheDeclaredNonNullType_Row1() {
        // Probe f1: Dog on one side and Cat on the other join to Animal.
        let report = Join(`package T
open class Animal {
    var Name string = "a"
}
class Dog : Animal { }
class Cat : Animal { }
func Run(x Animal?, c bool) string {
    if c {
        if x !is Dog { return "" }
    } else {
        if x !is Cat { return "" }
    }
    return x.Name
}`)
        Assert.Equal([]string{"8|x|nil|Animal|R1"}, report)
    }

    @Fact
    func AReadThatChangesMemberSelection_IsReportedAtTheRead() {
        // Probe f6: after the join the read selects `Dog.Name`, not `Animal.Name`.
        // The report names the read, not the join.
        let lines = Capture(`package T
open class Animal {
    prop Name string -> "animal"
}
class Dog : Animal {
    prop Name string -> "dog"
}
func Run(x Animal) string {
    if x is Dog { } else { return "" }
    return x.Name
}`)
        Assert.Equal([]string{"10|x|Animal|Dog|type-test"}, Rows(lines, "R"))
    }

    @Fact
    func AReadThatOnlyGainsANilCheck_IsReportedAsNullability() {
        let lines = Capture(`package T
func Get() string? { return nil }
func Run() int32 {
    let s string? = Get()
    if s != nil { Console.WriteLine("y") } else { return 0 }
    return s.Length
}`)
        Assert.Equal([]string{"6|s|string?|string|nullability"}, Rows(lines, "R"))
    }

    @Fact
    func AgreementsAreNotReported() {
        // `if`-join (#2159), an early-exit lift (#700) and a plain narrowing
        // that no branch changes: the passes and the shadow agree.
        let report = Join(`package T
func Get() string? { return nil }
func A() int32 {
    var s string? = Get()
    if s == nil { s = "a" }
    return s.Length
}
func B() int32 {
    let s string? = Get()
    if s == nil { return 0 }
    return s.Length
}
func C(s string?) int32 {
    if s != nil {
        if s.Length > 0 { return 1 }
    }
    return 0
}`)
        Assert.Empty(report)
    }

    @Fact
    func AKillInTheExitingBranchDoesNotHideTheFactFromTheNextBranch_Row2() {
        // The then-branch assigns `t` and returns. Both branches share the
        // frames, so the else-branch sees `t` killed. The shadow restores the
        // entry fact for the else-branch, so the join keeps it.
        let report = Join(`package T
func Get() string? { return nil }
func Run(c bool) int32 {
    var t string? = Get()
    if t == nil { return 0 }
    if c {
        t = nil
        return 1
    } else {
        Console.WriteLine("x")
    }
    return t.Length
}`)
        Assert.Equal([]string{"6|t|nil|string|R2"}, report)
    }

    @Fact
    func ANestedJoinFeedsTheOuterJoin() {
        // The inner `if` proves `t` and `o` on its own (row R1, the else-branch
        // exits). The current passes do not lift those facts, but the outer
        // join must still see them: its then-branch ends with `t` non-nil, so
        // the outer join agrees with the passes and reports nothing for the
        // outer `if`.
        let report = Join(`package T
func Run(a int32, o object?) int32 {
    var t string? = nil
    if a == 1 {
        if o is string x {
            t = x
        } else {
            return 0
        }
    } else {
        t = "b"
    }
    return t.Length
}`)
        Assert.Equal([]string{"5|o|nil|string|R1", "5|t|nil|string|R1"}, report)
    }

    @Fact
    func ComposedEffectsEqualTheEffectsOfAFullWalk() {
        // Each statement composes its effects from the recorded effects of its
        // child statements. The comparison mode checks the result against a
        // full walk and reports a difference as UNCLASSIFIED(effects-compose).
        NarrowingComparison.BeginCapture()
        using let measurements = CompilationMeasurements.Start("test")
        var lines = List[string]()
        try {
            Evaluate(`package T
func Get() string? { return nil }
func Clear(ref s string?) { s = nil }
func Run(c bool, n int32) int32 {
    var s string? = Get()
    var t string? = Get()
    var total = 0
    if c {
        total = total + 1
        if s != nil { Clear(ref t) }
    } else {
        for var i = 0; i < n; i++ {
            total = total + i
        }
    }
    try {
        total = total + 2
    } catch {
        s = nil
    }
    return total
}
func Closures(items []string) int32 {
    var total = 0
    for item in items {
        let Resolve = func(x string) {
            for ch in x {
                var open = ch
                total = total + 1
            }
        }
        Resolve(item)
    }
    return total
}`)
        } finally {
            lines = NarrowingComparison.EndCapture()
        }
        Assert.Empty(lines.Where((line string) -> line.Contains("effects-compose")).ToArray())
        Assert.True(measurements.GetCounter("narrowing.effects-composed") > 0L)
        Assert.True(measurements.GetCounter("narrowing.effects-child-reuses") > 0L)
        // The function literal of `Closures` is analysed at its call site, so the
        // statements that contain it are walked and not composed.
        Assert.True(measurements.GetCounter("narrowing.effects-walked-for-closure") > 0L)
    }

    @Fact
    func TheBinderContextProjectsItsFramesInnermostFirst() {
        // BinderContext.Narrowing is the state value of the frame stack: the
        // innermost frame that holds a path wins, like the frame query.
        let x = LocalVariableSymbol("x", false, NullableTypeSymbol.Get(TypeSymbol.Object))
        let y = LocalVariableSymbol("y", false, NullableTypeSymbol.Get(TypeSymbol.Object))
        let context = BinderContext(BoundScope(nil))
        let outer = Dictionary[AccessPath, TypeSymbol]()
        outer[AccessPath.ForVariable(x)] = TypeSymbol.Object
        outer[AccessPath.ForVariable(y)] = TypeSymbol.String
        let inner = Dictionary[AccessPath, TypeSymbol]()
        inner[AccessPath.ForVariable(x)] = TypeSymbol.String
        context.NarrowedVariables.Add(outer)
        context.NarrowedVariables.Add(inner)
        Assert.Equal(TypeSymbol.String, context.Narrowing.NarrowedType(AccessPath.ForVariable(x)))
        Assert.Equal(TypeSymbol.String, context.Narrowing.NarrowedType(AccessPath.ForVariable(y)))
        context.NarrowedVariables.RemoveAt(1)
        Assert.Equal(TypeSymbol.Object, context.Narrowing.NarrowedType(AccessPath.ForVariable(x)))
    }

    @Fact
    func TheReportIsDeterministic() {
        let source = `package T
func Get() string? { return nil }
func Run(c bool, k int32) int32 {
    var s string? = Get()
    var t string? = Get()
    if s != nil { Console.WriteLine("y") } else { return 0 }
    switch k {
        case 1 { t = "a" }
        default { return 0 }
    }
    return s.Length + t.Length
}`
        let first = Capture(source)
        let second = Capture(source)
        Assert.NotEmpty(first)
        Assert.Equal(first, second)
    }

    @Fact
    func ComparisonMode_DoesNotChangeTheDiagnostics() {
        let source = `package T
func Get() string? { return nil }
func Run() int32 {
    let s string? = Get()
    if s != nil { Console.WriteLine("y") } else { return 0 }
    return s.Length
}`
        let plain = Evaluate(source)
        NarrowingComparison.BeginCapture()
        var compared EmittedOracleResult
        try {
            compared = Evaluate(source)
        } finally {
            NarrowingComparison.EndCapture()
        }
        Assert.NotEmpty(plain.Diagnostics)
        Assert.Equal(
            plain.Diagnostics.Select((d Diagnostic) -> d.ToString()).ToArray(),
            compared.Diagnostics.Select((d Diagnostic) -> d.ToString()).ToArray()
        )
    }

    @Fact
    func WithoutACapture_NothingIsComputed() {
        Assert.False(NarrowingComparison.Enabled)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate([]string{source}, EmittedOracleOptions{IsLibrary: true})
        }

        private func Capture(source string) List[string] {
            NarrowingComparison.BeginCapture()
            var lines = List[string]()
            try {
                Evaluate(source)
            } finally {
                lines = NarrowingComparison.EndCapture()
            }
            return lines
        }

        // Join entries as `line|path|old|new|row`.
        private func Join(source string)[]string -> Rows(Capture(source), "J")

        private func Rows(lines List[string], kind string)[]string {
            let result = List[string]()
            for line in lines {
                let fields = line.Split('\t')
                if fields[0] != kind {
                    continue
                }
                let location = fields[1]
                let lineNumber = location.Substring(location.LastIndexOf(':') + 1)
                result.Add("${lineNumber}|${fields[2]}|${fields[3]}|${fields[4]}|${fields[5]}")
            }
            return result.ToArray()
        }
    }
}
