// <copyright file="Adr0200BlockTailTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import System.Linq
import Xunit

/// ADR-0202 / issues #4963, #4965, #4966: one rule for what the last item of a
/// value-capable block means, a `never` type for a value block whose end is
/// unreachable, and statement meaning for if/switch where the value is
/// discarded. Each test is an issue repro (or a shape the rule covers) run
/// end to end; the expected output is the program's exact stdout.
open class Adr0200BlockTailTests {
    // #4963 §1: comma arms in the expression form, next to the statement form.
    @Fact
    func CommaArms_MeanTheSameInBothSwitchForms() {
        AssertOutput(`import System
let x = 2
switch x {
case 1, 2 { Console.WriteLine("stmt one-or-two") }
default { Console.WriteLine("stmt other") }
}
let s = switch x {
case 1, 2: "expr one-or-two"
default: "expr other"
}
Console.WriteLine(s)
Console.WriteLine(switch 3 { case 1, 2: "low" default: "other" })`, "stmt one-or-two\nexpr one-or-two\nother\n")
    }

    // #4963 §2: a switch expression is the trailing value of a block, an
    // if-expression branch and an arrow-lambda block body.
    @Fact
    func SwitchExpression_IsTheTrailingValueOfABlock() {
        AssertOutput(`import System
let x = 1
let a = {
    let y = x
    switch y {
    case 1: "block-one"
    default: "other"
    }
}
let c = true
let b = if c {
    switch x {
    case 1: "if-one"
    default: "other"
    }
} else { "none" }
let f Func[int32, string] = (v) -> {
    Console.WriteLine("in")
    switch v {
    case 1: "lambda-one"
    default: "other"
    }
}
Console.WriteLine(a)
Console.WriteLine(b)
Console.WriteLine(f(1))`, "block-one\nif-one\nin\nlambda-one\n")
    }

    // #4965 §1: a value block ending in `throw` is typed `never` and unifies.
    @Fact
    func ValueBlockEndingInThrow_UnifiesWithTheOtherBranch() {
        AssertOutput(`import System
func ter(c bool) int32 -> c ? 1 : throw Exception("ternary")
func sw(x int32) int32 -> switch x {
case 1: 1
default: throw Exception("switch arm")
}
func ifx(c bool) int32 -> if c { 1 } else { throw Exception("if branch") }
func blk() int32 {
    let v int32 = {
        Console.WriteLine("prefix")
        throw Exception("block tail")
    }
    return v
}
Console.WriteLine(ter(true) + sw(1) + ifx(true))
try {
    ifx(false)
} catch (e Exception) {
    Console.WriteLine(e.Message)
}
try {
    blk()
} catch (e Exception) {
    Console.WriteLine(e.Message)
}`, "3\nif branch\nprefix\nblock tail\n")
    }

    // #4965 §2: `return` / `continue` tails; the other branch's value flows on.
    @Fact
    func ValueBlockEndingInReturnOrContinue_IsNever() {
        AssertOutput(`import System
func f(c bool) int32 {
    let a = if c { 1 } else { return 0 }
    return a + 10
}
func g() {
    for var i = 0; i < 3; i++ {
        let v = if i == 1 { continue } else { i * 10 }
        Console.WriteLine(v)
    }
}
Console.WriteLine(f(true))
Console.WriteLine(f(false))
g()`, "11\n0\n0\n20\n")
    }

    // ADR-0202 §5: the exit predicate covers break, structured exits, and
    // defer/using prefixes; evaluation order of a partially evaluated operand
    // is kept (the left operand runs before the exiting branch).
    @Fact
    func NeverBlocks_KeepEvaluationOrderAndCleanup() {
        AssertOutput(`import System
import System.IO
func log(s string, v int32) int32 {
    Console.WriteLine(s)
    return v
}
func plus(c bool) int32 {
    let x = log("left", 1) + if c { log("right", 2) } else { return -1 }
    return x
}
func sw(k int32) int32 {
    let v int32 = {
        switch k {
        case 1 { return 11 }
        default { return 22 }
        }
    }
    return v
}
func cleanup(c bool) int32 {
    let v int32 = if c { 1 } else {
        using let m = MemoryStream()
        defer Console.WriteLine("deferred")
        return 7
    }
    return v + 100
}
func loop() int32 {
    var n = 0
    while true {
        n = n + if n < 3 { 1 } else { break }
    }
    return n
}
Console.WriteLine(plus(true))
Console.WriteLine(plus(false))
Console.WriteLine(sw(1) + sw(2))
Console.WriteLine(cleanup(true))
Console.WriteLine(cleanup(false))
Console.WriteLine(loop())`, "left\nright\n3\nleft\n-1\n33\n101\ndeferred\n7\n3\n")
    }

    // #4965 §1/§2 inside a lambda: returns inside a trailing if-expression
    // supply the lambda's type (they used to report GS0277), and an `if let`
    // tail whose branches exit is the expression form.
    @Fact
    func LambdaTailWithExitingBranches_TakesItsTypeFromTheReturns() {
        AssertOutput(`import System
let f = (c bool) -> { if c { return 1 } else { return 2 } }
let wide = (c bool) -> { if c { return 1 } else { return int64(5) } }
let g Func[string?, int32] = (s) -> {
    if let t = s { return t.Length } else { return -1 }
}
Console.WriteLine(f(false))
Console.WriteLine(wide(false).GetType().Name)
Console.WriteLine(g("abc") + g(nil))`, "2\nInt64\n2\n")
    }

    // #4965 §3: a final nested block is the value in a lambda body as it is
    // in a block expression.
    @Fact
    func FinalNestedBlock_IsTheValueInLambdaBodies() {
        AssertOutput(`import System
let v = {
    let a = 1
    { a + 1 }
}
Console.WriteLine(v)
let f Func[int32] = () -> {
    let a = 1
    { a + 1 }
}
Console.WriteLine(f())`, "2\n2\n")
    }

    // #4965 §3 compatibility: a nested block (or if-let) whose value is void,
    // or whose branches mix void and non-void, leaves an inferred lambda void,
    // so the Action overload is still chosen; only a value tail picks Func.
    @Fact
    func FinalNestedBlock_OnlyAValueTailChangesTheInferredType() {
        AssertOutput(`import System
import System.Collections.Generic
func Run(f Func[int32]) { Console.WriteLine("func ${f()}") }
func Run(a Action) {
    a()
    Console.WriteLine("action")
}
let list = List[int32]{1, 2}
let c = true
Run(() -> {
    { Console.WriteLine("void nested") }
})
Run(() -> {
    { if c { list.Remove(1) } else { list.Clear() } }
})
Run(() -> {
    let o object? = "s"
    if let s = o as string { list.Add(s.Length) } else { list.Clear() }
})
Run(() -> {
    { 40 + 2 }
})
Run(() -> {
    { 40 + 2 }
    return
})
Console.WriteLine(list.Count)`, "void nested\naction\naction\naction\nfunc 42\naction\n2\n")
    }

    // #4966 §1: `-> { … }` on a function is the lambda's block body.
    @Fact
    func ArrowFunctionBlockBody_IsABlockBody() {
        AssertOutput(`import System
func fnArrow(x int32) int32 -> {
    if x > 0 { return 1 }
    return 2
}
func fnArrowVoid(x int32) -> {
    for var i = 0; i < x; i++ { Console.WriteLine("fn ${i}") }
}
func fnTail(x int32) int32 -> {
    let y = x * 2
    y + 1
}
func fnNested(x int32) int32 -> {
    let y = x
    { y * 3 }
}
class C {
    var n int32
    prop P int32 -> {
        let d = n * 2
        d
    }
}
let lamArrow Func[int32, int32] = (x) -> {
    if x > 0 { return 1 }
    return 2
}
let lamArrowVoid Action[int32] = (x) -> {
    for var i = 0; i < x; i++ { Console.WriteLine("lam ${i}") }
}
Console.WriteLine(fnArrow(1) + lamArrow(1) + fnArrow(-1))
fnArrowVoid(2)
lamArrowVoid(2)
Console.WriteLine(fnTail(4) + fnNested(2))
let o = C()
o.n = 21
Console.WriteLine(o.P)`, "4\nfn 0\nfn 1\nlam 0\nlam 1\n15\n42\n")
    }

    // #4966 §2: a void arrow body (function, lambda, setter) takes an `if`
    // without `else` and a switch with void arms; a void switch needs no
    // default arm and runs none for an unmatched value.
    @Fact
    func VoidArrowBodies_TakeIfWithoutElseAndVoidSwitches() {
        AssertOutput(`import System
func blk(c bool) { if c { Console.WriteLine("blk") } }
func arr(c bool) -> if c { Console.WriteLine("arr") }
let lam Action[bool] = (c) -> if c { Console.WriteLine("lam") }
let inferred = (c bool) -> if c { Console.WriteLine("inferred") }
class C {
    var n int32
    prop P int32 {
        get -> n
        set -> if value > 0 { n = value }
    }
}
func sw(x int32) -> switch x {
case 1: Console.WriteLine("one")
default: Console.WriteLine("other")
}
let noDefault Action[int32] = (x) -> switch x {
case 1, 2: Console.WriteLine("low ${x}")
}
func stmt(x int32) {
    switch x {
    case 1: Console.WriteLine("stmt one")
    case 2: Console.WriteLine("stmt two")
    }
}
blk(true)
arr(true)
arr(false)
lam(true)
inferred(true)
let o = C()
o.P = 3
o.P = -5
Console.WriteLine(o.P)
sw(1)
sw(9)
noDefault(2)
noDefault(7)
stmt(2)
stmt(3)`, "blk\narr\nlam\ninferred\n3\none\nother\nlow 2\nstmt two\n")
    }

    // ADR-0202 §6: an if/else with one void branch in a void lambda is the void
    // `if` (it reported GS0263), and a non-void value of the other branch is
    // discarded.
    @Fact
    func MixedVoidBranches_InADiscardedPosition_AreTheVoidIf() {
        AssertOutput(`import System
import System.Collections.Generic
let list = List[int32]{1, 2, 3}
let f Action[bool] = (c) -> { if c { list.Remove(1) } else { list.Clear() } }
f(true)
Console.WriteLine(list.Count)
f(false)
Console.WriteLine(list.Count)`, "2\n0\n")
    }

    // A `defer` / `using let` prefix wraps the rest of the block in a try, so a
    // `continue` / `break` tail sits inside it; it still leaves the block, and
    // the cleanup runs first.
    @Fact
    func CleanupWrappedLoopExit_IsStillAnExitingTail() {
        AssertOutput(`import System
func Log(s string) { Console.WriteLine(s) }
func f() int32 {
    var t = 0
    for var i = 0; i < 4; i++ {
        let v int32 = if i == 1 {
            defer Log("skip ${i}")
            continue
        } else if i == 3 {
            defer Log("stop ${i}")
            break
        } else { i }
        t = t + v
    }
    return t
}
Console.WriteLine(f())`, "skip 1\nstop 3\n2\n")
    }

    // A `never` tail after a cleanup prefix keeps no result local (it was
    // GS9998: a `never`-typed local cannot be encoded).
    @Fact
    func NeverTailAfterCleanup_KeepsNoResultStorage() {
        AssertOutput(`import System
let f = (c bool) -> {
    defer Console.WriteLine("d")
    if c { return 1 } else { return 2 }
}
Console.WriteLine(f(true))
let g Func[bool, int32] = (c) -> {
    using let m = System.IO.MemoryStream()
    if c { return 3 } else { throw Exception("g") }
}
Console.WriteLine(g(true))`, "d\n1\n3\n")
    }

    // A block-bodied lambda whose every path exits infers void with no target,
    // like `() -> { throw e }` (it was GS9998: `never` has no CLR form), and
    // adopts a delegate target's type.
    @Fact
    func NeverOnlyBlockLambda_IsVoidWithoutATarget() {
        AssertOutput(`import System
let f = () -> { { throw Exception("x") } }
let g Func[int32] = () -> { { throw Exception("y") } }
let h = (c bool) -> { if c { throw Exception("a") } else { throw Exception("b") } }
try { f() } catch (e Exception) { Console.WriteLine(e.Message) }
try { g() } catch (e Exception) { Console.WriteLine(e.Message) }
try { h(true) } catch (e Exception) { Console.WriteLine(e.Message) }`, "x\ny\na\n")
    }

    // A guarded discard can fail, so a switch whose only catch-all is
    // `case _ when …` does not make the block's end unreachable.
    @Fact
    func GuardedDiscard_DoesNotMakeTheEndUnreachable() {
        AssertDiagnostic(`func f(x int32) int32 {
    let v int32 = {
        switch x {
        case _ when x > 0 { return 1 }
        }
    }
    return v
}`, "GS0277", 6, 5)
        AssertOutput(`import System
func f(x int32) int32 {
    let v int32 = {
        switch x {
        case _ when x > 0 { return 1 }
        default { return 0 }
        }
    }
    return v
}
Console.WriteLine(f(5) + f(-5))`, "1\n")
    }

    // Comma arms accept type/property patterns in both forms.
    @Fact
    func CommaArms_AcceptPropertyPatterns() {
        AssertOutput(`import System
let a = switch "ab" {
case string { Length: 1 }, string { Length: 2 }: "short"
default: "long"
}
switch "abc" {
case string { Length: 1 }, string { Length: 3 } { Console.WriteLine("stmt") }
default { Console.WriteLine("other") }
}
Console.WriteLine(a)`, "stmt\nshort\n")
    }

    // A `return` nested in another `return`'s operand contributes to the
    // inferred type and is converted to it, on both paths.
    @Fact
    func ReturnInsideAReturnOperand_IsInferredAndConverted() {
        AssertOutput(`import System
let f = (c bool) -> { return if c { return int64(2) } else { 1 } }
let g = (c bool) -> { return if c { 1 } else { return int64(3) } }
Console.WriteLine("${f(true)} ${f(false)} ${g(true)} ${g(false)} ${f(true).GetType().Name}")`, "2 1 1 3 Int64\n")
    }

    // Operands spilled around an exiting operand keep their left-to-right
    // order and allocate no `never` storage (it was GS9998).
    @Fact
    func ExitingCallArguments_KeepOrderAndNeedNoStorage() {
        AssertOutput(`import System
func Sink(a int32, b int32) int32 { return a * 10 + b }
func log(s string, v int32) int32 {
    Console.WriteLine(s)
    return v
}
func one(c bool) int32 {
    return Sink(log("first", 1), if c { log("second", 2) } else { return -1 })
}
func both(c bool) int32 {
    return Sink(if c { return 1 } else { return 2 }, if c { 3 } else { return 4 })
}
Console.WriteLine(one(true))
Console.WriteLine(one(false))
Console.WriteLine(both(true))
Console.WriteLine(both(false))`, "first\nsecond\n12\nfirst\n-1\n1\n2\n")
    }

    // An exiting operand spilled around an await runs as a statement; nothing
    // after it (the await, the call) runs.
    @Fact
    func ExitingOperandBeforeAnAwait_StopsTheSequence() {
        AssertOutput(`import System
import System.Threading.Tasks
func Sink(a int32, b int32) int32 { return a * 10 + b }
async func Three() Task[int32] {
    Console.WriteLine("awaited")
    return 3
}
async func f(c bool) Task[int32] {
    return Sink(if c { 1 } else { return -1 }, await Three())
}
async func g() Task[int32] {
    return Sink(throw Exception("thrown"), await Three())
}
Console.WriteLine(f(true).Result)
Console.WriteLine(f(false).Result)
try { g().Wait() } catch (e AggregateException) { Console.WriteLine(e.InnerException!!.Message) }`, "awaited\n13\n-1\nthrown\n")
    }

    // A block lambda whose every return never completes is void with no target.
    @Fact
    func NeverReturnsOnlyBlockLambda_IsVoidWithoutATarget() {
        AssertOutput(`import System
let f = () -> { return { throw Exception("x") } }
let g Func[int32] = () -> { return { throw Exception("y") } }
try { f() } catch (e Exception) { Console.WriteLine(e.Message) }
try { g() } catch (e Exception) { Console.WriteLine(e.Message) }`, "x\ny\n")
    }

    // A bare `default` in a discarded position has no target type (GS0362),
    // and an untyped local whose inferred tuple type has a `never` element is
    // GS0124 (both were invalid IL / GS9998).
    @Fact
    func DiscardedBareDefaultAndNeverTupleLocal_AreDiagnosed() {
        AssertDiagnostic(`func f(x int32) -> switch x {
case 1: System.Console.WriteLine("one")
default: default
}`, "GS0362", 3, 10)
        AssertDiagnostic(`func f(c bool) -> if c {
    let n = 1
    default
}`, "GS0362", 3, 5)
        AssertDiagnostic(`func f(c bool) int32 {
    let t = (if c { return 1 } else { return 2 }, 0)
    return 3
}`, "GS0124", 2, 13)
    }

    // A void switch with no default can run no arm, so it does not
    // definitely assign anything (GS0238 for the out parameter), while a
    // default arm that assigns makes it definite.
    @Fact
    func VoidSwitchWithoutDefault_DoesNotDefinitelyAssign() {
        let result = EmittedOracle.Evaluate(`func Set(out a int32) { a = 1 }
func Bad(x int32, out a int32) {
    switch x {
    case 1: Set(out a)
    }
}`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0238")
        AssertOutput(`import System
func Set(out a int32, v int32) { a = v }
func Good(x int32, out a int32) {
    switch x {
    case 1: Set(out a, 10)
    default: Set(out a, 20)
    }
}
var r int32
Good(2, out r)
Console.WriteLine(r)`, "20\n")
    }

    @Fact
    func VoidSwitchWildcard_AssignsOnlyWhenUnguarded() {
        AssertOutput(`import System
func Set(out a int32) { a = 1 }
func Good(x int32, out a int32) {
    switch x { case _: Set(out a) }
}
var r int32
Good(2, out r)
Console.WriteLine(r)`, "1\n")
        let guarded = EmittedOracle.Evaluate(`func Set(out a int32) { a = 1 }
func Bad(x int32, out a int32) {
    switch x { case _ when x > 0: Set(out a) }
}`)
        Assert.Contains(guarded.Diagnostics, (d Diagnostic) -> d.Id == "GS0238")
    }

    @Fact
    func VoidSwitchWildcard_ReplacesCallableStateOnlyWhenUnguarded() {
        // The goto analysis walks the whole finally body. The no-op call
        // keeps the switch void instead of yielding the assignment's value.
        AssertOutput(`import System
func Run(x int32) {
    var text string? = nil
    text = "safe"
    try { goto Done }
    finally {
        let mutate = func() { text = nil }
        let noop = func() { }
        var action (() -> void) = mutate
        switch x { case _: { action = noop noop() } }
        action()
    }
Done:
    Console.WriteLine(text.Length)
}
Run(1)`, "4\n")
        let guarded = EmittedOracle.Evaluate(`import System
func Run(x int32) {
    var text string? = nil
    text = "safe"
    try { goto Done }
    finally {
        let mutate = func() { text = nil }
        let noop = func() { }
        var action (() -> void) = mutate
        switch x { case _ when x < 0: { action = noop noop() } }
        action()
    }
Done:
    Console.WriteLine(text.Length)
}`)
        Assert.Contains(guarded.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
    }

    @Theory
    @InlineData(`func f(c bool) -> if c {
    defer System.Console.WriteLine("d")
    default
}`, 3, 5)
    @InlineData(`func f(c bool) -> if c {
    using let stream = System.IO.MemoryStream()
    default
}`, 3, 5)
    @InlineData(`func f(c bool, x int32) -> if c {
    switch x { default: default }
}`, 2, 25)
    @InlineData(`func f(c bool, x int32) -> if c {
    defer System.Console.WriteLine("d")
    switch x { default: default }
}`, 3, 25)
    func DiscardedBareDefaultUnderCleanupOrSwitch_IsDiagnosed(source string, line int32, column int32) {
        AssertDiagnostic(source, "GS0362", line, column)
    }

    @Fact
    func ContextualDefaultUnderCleanup_StillTakesItsTargetType() {
        AssertOutput(`import System
func f(c bool) int32 -> if c {
    defer Console.WriteLine("cleanup")
    default
} else { 7 }
Console.WriteLine(f(true))
Console.WriteLine(f(false))`, "cleanup\n0\n7\n")
    }

    @Fact
    func LongNestedLambdaTail_StillSelectsTheValueOverload() {
        let body = System.Text.StringBuilder()
        for var i = 0; i < 2000; i++ {
            body.Append("Log()\n")
        }
        AssertOutput(`import System
func Log() { }
func Run(f Func[int32]) { Console.WriteLine("func ${f()}") }
func Run(a Action) { a() Console.WriteLine("action") }
Run(() -> { {
` + body.ToString() + "42 } })", "func 42\n")
    }

    @Fact
    func VoidSwitchGuardAssignments_ReachTheUnmatchedPath() {
        AssertOutput(`import System
func Set(out a int32) { a = 1 }
func F(x int32, out a int32) {
    switch x { case _ when { Set(out a) false }: Console.WriteLine("unused") }
}
func G(x int32, out a int32) {
    switch x {
    default: Console.WriteLine("default")
    case _ when { Set(out a) false }: Console.WriteLine("unused")
    }
}
var a int32
F(1, out a)
Console.WriteLine(a)
G(1, out a)
Console.WriteLine(a)`, "1\ndefault\n1\n")
    }

    @Theory
    @InlineData("")
    @InlineData("default: noop()\n")
    func VoidSwitchGuardCallableEffects_ReachTheUnmatchedPath(defaultArm string) {
        let source = `func Run(x int32) int32 {
    var text string? = nil
    text = "safe"
    try { goto Done }
    finally {
        let mutate = func() { text = nil }
        let noop = func() { }
        var action (() -> void) = noop
        switch x {
` + defaultArm + `case _ when { action = mutate false }: { action = noop noop() }
        }
        action()
    }
Done:
    return text.Length
}
Run(1)`
        let result = EmittedOracle.Evaluate(source)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func LongTrailingIfLet_StillSelectsTheValueOverload() {
        let body = System.Text.StringBuilder()
        for var i = 0; i < 2000; i++ {
            body.Append("Log()\n")
        }
        AssertOutput(`import System
func Log() { }
func Run(f Func[int32]) { Console.WriteLine("func ${f()}") }
func Run(a Action) { a() Console.WriteLine("action") }
let input string? = "value"
Run(() -> { if let s = input {
` + body.ToString() + "42 } else { 0 } })", "func 42\n")
    }

    @Theory
    @InlineData("case _ when flag && { action = noop false }: noop()", "nil", true)
    @InlineData("case _ when !flag || { action = noop false }: noop()", "nil", true)
    @InlineData("case 0 and == { action = noop 0 }: noop() default: noop()", "nil", true)
    @InlineData("case 1 or == { action = noop 0 }: noop() default: noop()", "nil", true)
    @InlineData("case _ when (token ?? { action = noop \"other\" }) == \"unused\": noop()", "\"present\"", true)
    @InlineData("case _ when token?.Contains({ action = noop \"unused\" }) ?? false: noop()", "nil", true)
    @InlineData("case _ when (if flag { action = noop false } else { false }): noop()", "nil", true)
    @InlineData("case _ when (flag ? { action = noop false } : false): noop()", "nil", true)
    @InlineData("case _ when (if flag { action = noop false } else { action = noop false }): noop()", "nil", false)
    func ShortCircuitSwitchPaths_PreserveSkippedCallableTargets(arm string, tokenArgument string, mustReject bool) {
        let source = `func Run(flag bool, x int32, token string?) int32 {
    var text string? = nil
    text = "safe"
    try { goto Done }
    finally {
        let mutate = func() { text = nil }
        let noop = func() { }
        var action (() -> void) = mutate
        switch x {
` + arm + `
        }
        action()
    }
Done:
    return text.Length
}
Run(false, 1, ` + tokenArgument + ")"
        let result = EmittedOracle.Evaluate(source)
        if mustReject {
            let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
            Assert.Equal("Length", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        } else {
            Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
            Assert.Null(result.UnhandledException)
        }
    }

    @Theory
    @InlineData("if c { s } else { nil }")
    @InlineData("(if c { s } else { nil })")
    func TrailingIfLetInitializerBraces_DoNotChangeTheOverload(initializer string) {
        AssertOutput(`import System
func Run(f Func[int32]) { Console.WriteLine("func ${f()}") }
func Run(a Action) { a() Console.WriteLine("action") }
let c = true
let s string? = "value"
Run(() -> { if let x = ` + initializer + " { 42 } else { 0 } })", "func 42\n")
    }

    // Value position keeps its rules: GS0276, GS0277, GS0176, and GS0124 for a
    // `never` initializer (which crashed the compiler, GS9998, before).
    @Fact
    func ValuePositionRules_StillReport() {
        AssertDiagnostic(`let x = if true { 1 }`, "GS0276", 1, 9)
        AssertDiagnostic(`func f(k int32) int32 {
    let v int32 = {
        switch k {
        case 1 { break }
        default { return 2 }
        }
    }
    return v
}`, "GS0277", 7, 5)
        AssertDiagnostic(`let x = 1
let s = switch x { case 1: "one" }`, "GS0176", 2, 9)
        AssertDiagnostic(`func f() int32 {
    let a = throw System.Exception("x")
    return 0
}`, "GS0124", 2, 13)
        AssertDiagnostic(`func f(c bool) int32 {
    let a = if c { return 1 } else { return 2 }
    return 0
}`, "GS0124", 2, 13)
    }

    // A function whose body ends in a statement-position switch expression
    // whose arms all return passes the all-paths-return check (ADR-0069's own
    // example).
    @Fact
    func NeverValuedStatement_EndsTheFunctionBody() {
        AssertOutput(`import System
open class Animal { open func Describe() string -> "animal" }
class Dog : Animal { func Bark() string -> "woof" }
func Describe(a Animal) string {
    switch a {
        case d is Dog: { return a.Bark() }
        default: { return a.Describe() }
    }
}
Console.WriteLine(Describe(Dog()))
Console.WriteLine(Describe(Animal()))`, "woof\nanimal\n")
    }

    shared {
        private func AssertOutput(source string, expected string) {
            let result = EmittedOracle.Evaluate(source)
            Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
            Assert.Null(result.UnhandledException)
            Assert.Equal(expected, result.Output.Replace("\r\n", "\n"))
        }

        private func AssertDiagnostic(source string, id string, line int32, column int32) {
            let result = EmittedOracle.Evaluate(source)
            let matches = result.Diagnostics.Where((d Diagnostic) -> d.Id == id).ToList()
            Assert.NotEmpty(matches)
            Assert.Contains(
                matches,
                (d Diagnostic) -> d.Location.StartLine + 1 == line && d.Location.StartCharacter + 1 == column
            )
        }
    }
}
