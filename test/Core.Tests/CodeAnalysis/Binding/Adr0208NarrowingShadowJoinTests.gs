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
import System.IO
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
    func AReadIsReportedWhenTheFrameFactIsOlderThanTheShadowFact() {
        // The nil guard leaves `x -> Animal` in the frames. The type test then
        // proves `Dog` in the shadow flow only. The read is reported although a
        // frame fact exists, and the empty block and the empty `if` that follow
        // do not erase the newer `Dog` fact.
        let lines = Capture(`package T
open class Animal { prop Name string -> "animal" }
class Dog : Animal { prop Name string -> "dog" }
func Run(x Animal?, c bool) string {
    if x == nil { return "" }
    if x is Dog { } else { return "" }
    { }
    if c { } else { }
    return x.Name
}`)
        Assert.Equal([]string{"9|x|Animal?|Dog|type-test"}, Rows(lines, "R"))
        // The later merge points carry the refinement; only the `is` test reports it.
        Assert.Equal([]string{"6|x|Animal|Dog|R1"}, Rows(lines, "J"))
    }

    @Fact
    func AFailedGuardThatWritesTheRoot_KeepsTheNoArmPathHonest() {
        // Probe g3: `Clear(ref s)` stores nil and returns false, so the path where
        // no arm matched has no fact on `s`. The shadow must not report a gain.
        let lines = Capture(`package T
func Get() string? { return "a" }
func Clear(ref s string?) bool {
    s = nil
    return false
}
func Run() int32 {
    var s string? = Get()
    if s == nil { return 0 }
    switch 1 {
        case 1 when Clear(ref s) { return 0 }
    }
    return s.Length
}`)
        Assert.Empty(Rows(lines, "J"))
        Assert.Empty(Rows(lines, "R"))
    }

    @Fact
    func ACleanRunStillWritesEmptyReports() {
        let path = Path.Combine(Path.GetTempPath(), "gs_adr0208_" + Guid.NewGuid().ToString("N"))
        try {
            File.WriteAllText(path, "stale")
            File.WriteAllText(path + ".reads", "stale")
            NarrowingComparison.FlushTo(path)
            Assert.Equal("", File.ReadAllText(path))
            Assert.Equal("", File.ReadAllText(path + ".reads"))
        } finally {
            File.Delete(path)
            File.Delete(path + ".reads")
        }
    }

    @Fact
    func AConditionThatWritesTheRoot_StartsTheBranchesWithoutTheFact() {
        // `Clear(ref s)` stores nil. Neither branch starts from the guarded fact,
        // so the join reports nothing and the read is not narrowed.
        let lines = Capture(`package T
func Get() string? { return "a" }
func Clear(ref s string?) bool {
    s = nil
    return false
}
func Run() int32 {
    var s string? = Get()
    if s == nil { return 0 }
    if Clear(ref s) { } else { }
    return s.Length
}`)
        Assert.Empty(Rows(lines, "J"))
        Assert.Empty(Rows(lines, "R"))
    }

    @Fact
    func AGuardThatWritesTheRoot_ReachesTheDefaultArm() {
        let lines = Capture(`package T
func Get() string? { return "a" }
func Clear(ref s string?) bool {
    s = nil
    return false
}
func Run() int32 {
    var s string? = Get()
    if s == nil { return 0 }
    switch 1 {
        case 1 when Clear(ref s) { return 0 }
        default { }
    }
    return s.Length
}`)
        Assert.Empty(Rows(lines, "J"))
        Assert.Empty(Rows(lines, "R"))
    }

    @Fact
    func AReportOfADiscardedLoopBind_IsDropped() {
        // The first bind of the loop body reports a join for `if c { s = nil; return 0 }`.
        // The write `s = Get()` reaches the back edge, so the binder discards that bind
        // and binds again without the inherited fact. The report keeps nothing of it.
        let lines = Capture(`package T
func Get() string? { return nil }
func Run(c bool, n int32) int32 {
    var s string? = Get()
    if s == nil { return 0 }
    var total = 0
    for var i = 0; i < n; i++ {
        if c {
            s = nil
            return 0
        }
        total = total + s.Length
        s = Get()
    }
    return total
}`)
        Assert.Empty(Rows(lines, "J"))
        Assert.Empty(Rows(lines, "R"))
    }

    @Fact
    func AFreshProofAfterTheHeaderSurvivesToTheExit() {
        // `Update(ref s)` removes the entry proof. The `s == nil` test inside the
        // branch proves `s` again, and that proof is newer than the removal.
        let lines = Capture(`package T
func Get() string? { return "a" }
func Update(ref s string?) bool {
    s = Get()
    return true
}
func Run() int32 {
    var s string? = Get()
    if s == nil { return 0 }
    if Update(ref s) {
        if s == nil { return 0 }
    } else {
        return 0
    }
    return s.Length
}`)
        Assert.Equal([]string{"10|s|nil|string|R1"}, Rows(lines, "J"))
        Assert.Equal([]string{"15|s|string?|string|nullability"}, Rows(lines, "R"))
    }

    @Fact
    func AReadInsideTheBranchDoesNotSeeTheFactTheHeaderRemoved() {
        let lines = Capture(`package T
func Get() string? { return "a" }
func Clear(ref s string?) bool {
    s = nil
    return true
}
func Run() int32 {
    var s string? = Get()
    if s != nil { } else { return 0 }
    if Clear(ref s) {
        return s.Length
    }
    return 0
}`)
        Assert.Equal([]string{"9|s|nil|string|R1"}, Rows(lines, "J"))
        // Only the argument `ref s` is read before the header takes effect.
        Assert.Equal([]string{"10|s|string?|string|nullability"}, Rows(lines, "R"))
    }

    @Fact
    func AJoinOfSiblingsOnANonNullableRoot_IsNotAReadChange() {
        let lines = Capture(`package T
open class Animal { prop Name string -> "animal" }
class Dog : Animal { }
class Cat : Animal { }
func Run(x Animal, c bool) string {
    if c {
        if x !is Dog { return "" }
    } else {
        if x !is Cat { return "" }
    }
    return x.Name
}`)
        Assert.Empty(Rows(lines, "R"))
    }

    @Fact
    func AGuardAfterTheDefaultArm_StillRunsBeforeIt() {
        let lines = Capture(`package T
func Get() string? { return "a" }
func Clear(ref s string?) bool {
    s = nil
    return false
}
func Run() int32 {
    var s string? = Get()
    if s == nil { return 0 }
    switch 1 {
        default { }
        case 1 when Clear(ref s) { return 0 }
    }
    return s.Length
}`)
        Assert.Empty(Rows(lines, "J"))
        Assert.Empty(Rows(lines, "R"))
    }

    @Fact
    func AReadInALaterSiblingSeesTheFactAnEarlierSiblingKilled() {
        // The frames are shared, so the first branch kills `t` for the second one.
        // The shadow state of the second branch still has it.
        let lines = Capture(`package T
func Get() string? { return "a" }
func Run(c bool) int32 {
    var t string? = Get()
    if t == nil { return 0 }
    if c {
        t = nil
        return 1
    } else {
        return t.Length
    }
}`)
        Assert.Equal([]string{"10|t|string?|string|nullability"}, Rows(lines, "R"))
    }

    @Fact
    func AGuardAfterTheDefaultArm_DoesNotRemoveWhatTheDefaultArmWrote() {
        // The default arm assigns `s` after the entry proof. The guard that follows
        // runs first and removes the inherited proof, but the arm re-proves `s`.
        // The shadow keeps it, so the join gains `s` where the legacy passes lose it (R4).
        let lines = Capture(`package T
func Get() string? { return "a" }
func Clear(ref s string?) bool {
    s = nil
    return false
}
func Run() int32 {
    var s string? = Get()
    if s == nil { return 0 }
    switch 1 {
        default { s = "ok" }
        case 1 when Clear(ref s) { return 0 }
    }
    return s.Length
}`)
        Assert.Equal([]string{"10|s|nil|string|R4"}, Rows(lines, "J"))
        // The reads: the guard argument `ref s`, and the read after the switch.
        Assert.Equal([]string{"12|s|string?|string|nullability", "14|s|string?|string|nullability"}, Rows(lines, "R"))
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
        context.NarrowedVariables.Push(outer)
        context.NarrowedVariables.Push(inner)
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
