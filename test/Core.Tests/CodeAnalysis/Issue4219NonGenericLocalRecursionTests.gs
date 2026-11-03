// <copyright file="Issue4219NonGenericLocalRecursionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System.Linq
import Xunit

/// Issue #4219 umbrella remainder, workstream A: mutual-recursion groups for
/// NON-generic local functions. (cref:Issue4219GenericLocalRecursionTests)
/// covers the GENERIC case (b84bf800 and its #4221/#4223 follow-ups), which
/// already supports forward references and call cycles among a consecutive
/// run of `let name[T] = func (...) ... {...}` declarations. Plain
/// `let name = func (...) ... {...}` declarations had no such
/// mechanism — `StatementBinder.IsGenericLocalFunctionDeclaration`
/// required a type-parameter list, so a forward reference among non-generic
/// siblings reported GS0130 exactly like an ordinary undeclared name.
///
/// This extends the SAME prepare-then-bind signature-registration mechanism
/// (`StatementBinder.BindLocalFunctionLiteralGroup`,
/// `LambdaBinder.PrepareGenericLocalFunctionDeclaration` generalized to
/// tolerate a null type-parameter list) to a run of TWO OR MORE consecutive
/// non-generic local-function-literal `let` declarations — see
/// `StatementBinder.IsNonGenericLocalFunctionLiteralDeclaration` for why
/// the 2-or-more gate exists (a LONE non-generic literal keeps its existing
/// delegate-valued-variable representation, so no previously-legal program's
/// representation silently changes).
open class Issue4219NonGenericLocalRecursionTests {
    @Fact
    func TwoMember_NonCapturing_ForwardReferenceCycle() {
        let result = EmittedOracle.Evaluate(`func Run() int32 {
    let first = func(x int32, n int32) int32 {
        if n == 0 { return x }
        return second(x + 1, n - 1)
    }
    let second = func(x int32, n int32) int32 {
        if n == 0 { return x }
        return first(x + 1, n - 1)
    }
    return first(0, 4)
}
Run()`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(4, result.Value)
    }

    @Fact
    func ThreeMember_NonCapturing_ForwardReferenceCycle() {
        let result = EmittedOracle.Evaluate(`func Run() string {
    let first = func(n int32) string {
        if n == 0 { return "f" }
        return second(n - 1)
    }
    let second = func(n int32) string {
        if n == 0 { return "s" }
        return third(n - 1)
    }
    let third = func(n int32) string {
        if n == 0 { return "t" }
        return first(n - 1)
    }
    return first(5)
}
Run()`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("t", result.Value)
    }

    @Fact
    func TwoMember_Capturing_ForwardReferenceCycle_SharesCapture() {
        let result = EmittedOracle.Evaluate(`func Run() int32 {
    var outer = 1
    let first = func(x int32) int32 {
        if x == 0 { return outer }
        return second(x - 1)
    }
    let second = func(x int32) int32 {
        if x == 0 { return outer }
        return first(x - 1)
    }
    return first(3) + first(4)
}
Run()`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(2, result.Value)
    }

    @Fact
    func MutationInOneMember_VisibleToSiblingAcrossSeparateCalls() {
        // Each direct call to a capturing group member materializes its own
        // closure instance (ClosureEmitter.EmitGenericLocalClosureInstance);
        // correctness here relies on the pre-existing CaptureBoxingRewriter
        // boxing `outer` into a shared cell because it is reassigned, so
        // every instance's copy of the captured field aliases the same
        // storage. Confirms that mechanism composes with direct-call
        // dispatch for the non-generic case exactly as it already does for
        // the generic one (#4221).
        let result = EmittedOracle.Evaluate(`func Run() int32 {
    var outer = 0
    let bump = func() { outer = outer + 1 }
    let readIt = func() int32 { return outer }
    bump()
    bump()
    return readIt()
}
Run()`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(2, result.Value)
    }

    @Fact
    func SelfRecursion_StillWorksInsideAGroup() {
        let result = EmittedOracle.Evaluate(`func Run() int32 {
    let fact = func(n int32) int32 {
        if n <= 1 { return 1 }
        return n * fact(n - 1)
    }
    let unrelated = func(x int32) int32 { return x }
    return fact(5)
}
Run()`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(120, result.Value)
    }

    @Fact
    func LoneNonGenericLocal_UnaffectedByGrouping() {
        // Sanity: a single non-generic local (no sibling to form a run with)
        // is not part of any group and keeps working exactly as before.
        let result = EmittedOracle.Evaluate(`func Run() int32 {
    let first = func(x int32) int32 { return x + 1 }
    return first(41)
}
Run()`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(42, result.Value)
    }

    @Fact
    func DuplicateName_StillReportsGS0102() {
        let result = EmittedOracle.Evaluate(`func Run() int32 {
    let first = func(x int32) int32 { return x }
    let first = func(x int32) int32 { return x + 1 }
    return first(0)
}
Run()`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0102")
    }

    @Fact
    func OuterNameShadowedBySiblingInSameRun_ReportsAmbiguous() {
        // A group member's forward reference resolves the sibling name
        // BEFORE the sequential declaration that would otherwise shadow the
        // outer same-named function — matching the pre-existing generic-
        // group behavior (SameSignatureInOuterScope_RemainsAmbiguous in
        // Issue4219GenericLocalRecursionTests) rather than silently picking
        // one or the other.
        let result = EmittedOracle.Evaluate(`func helper(x int32) int32 { return 100 }
func Run() int32 {
    let a = func(x int32) int32 { return helper(x) }
    let helper = func(x int32) int32 { return 7 }
    return a(1)
}
Run()`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0266")
    }

    @Fact
    func ExplicitOuterTypeClause_FallsBackToOrdinaryDelegatePath_AndTypeChecks() {
        // A `let` with an explicit outer type clause is excluded from the
        // direct-call group (IsNonGenericLocalFunctionLiteralDeclaration
        // requires TypeClause: null) precisely because the group's
        // signature comes entirely from the literal itself — a declared
        // outer type would otherwise be silently ignored instead of type-
        // checked. Falling back to the ordinary path means a genuine
        // mismatch is still caught.
        let result = EmittedOracle.Evaluate(`func Run() int32 {
    let f (int32) -> string = func(x int32) int32 { return x }
    return 0
}
Run()`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0155")
    }

    @Fact
    func MixedGenericThenNonGenericSibling_ForwardReference_StillGS0130() {
        // Deliberately out of scope here (matches the existing generic/non-
        // generic mixed-group exclusion, see #4219's umbrella comment on
        // "mixed groups" being broader-parity, not this milestone): a
        // generic member's forward reference to a non-generic sibling
        // declared after it still fails exactly as before.
        let result = EmittedOracle.Evaluate(`func Run() int32 {
    let first[T] = func(x T) int32 { return second(0) }
    let second = func(x int32) int32 { return first(x) }
    return first(1)
}
Run()`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0130")
    }

    @Fact
    func NonCapturingGroupMember_MethodGroupConversion_StillWorks() {
        // Regression pin: before this change, EVERY non-generic
        // `let f = func ...` was a plain delegate-valued variable, so
        // converting its bare name to an explicit delegate type trivially
        // worked. Switching a 2+-member group's representation to a direct-
        // call FunctionSymbol (ExpressionBinder.IsMethodGroupCandidateUsable)
        // must not break that for a NON-capturing member.
        let result = EmittedOracle.Evaluate(`func Run() int32 {
    let first = func(x int32) int32 { return x + 1 }
    let second = func(x int32) int32 { return first(x) }
    let callback (int32) -> int32 = first
    return callback(41)
}
Run()`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(42, result.Value)
    }

    @Fact
    func CapturingGroupMember_MethodGroupConversion_KnownDeferredLimitation() {
        // Documented, deliberately deferred limitation: a CAPTURING member
        // of a 2+ non-generic local-function group has no single stable
        // closure instance to bind a bare-name delegate conversion to (each
        // direct call it makes materializes its own instance). This matches
        // the PRE-EXISTING behavior of a capturing GENERIC local function —
        // not a new restriction introduced for the non-generic case — but IS
        // a narrowing relative to the old non-generic delegate-variable
        // baseline, where this converted trivially. Reported here so the
        // gap is pinned, not silently regressed without a test.
        let result = EmittedOracle.Evaluate(`func Run() int32 {
    var outer = 41
    let first = func(x int32) int32 { return outer + x }
    let second = func(x int32) int32 { return first(x) }
    let callback (int32) -> int32 = first
    return callback(1)
}
Run()`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0126")
    }

    @Fact
    func AdjacentUnrelatedCapturingLocals_NoCrossReference_BareNameConversionStillWorks() {
        // Review-caught regression: the group-membership gate is source
        // ADJACENCY of two non-generic `let name = func ...` locals, not
        // actual mutual/forward recursion. Without an additional check, two
        // ordinary, UNRELATED capturing callbacks declared back-to-back
        // (neither one's body ever names the other — the common
        // callback-registration shape) were swept into the same direct-call
        // group as a genuinely recursive pair, and lost the ability to
        // convert a capturing member's bare name to a delegate value even
        // though nothing about the pair is recursive. This must keep
        // working exactly as it did before #4219's non-generic group
        // support existed.
        let result = EmittedOracle.Evaluate(`func Register(f () -> void) int32 {
    f()
    return 0
}
func Run() int32 {
    var count = 0
    let onClick = func() { count = count + 1 }
    let onLog = func() { Console.Write("") }
    Register(onClick)
    return count
}
Run()`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(1, result.Value)
    }

    @Fact
    func AdjacentSelfRecursiveAndUnrelatedCapturingLocal_NoCrossReference_BareNameConversionStillWorks() {
        // Same regression, self-recursion variant: a self-recursive member
        // referencing only its OWN name does not count as a cross-reference
        // to a SIBLING — self-recursion already works without group
        // membership (see SelfRecursion_StillWorksInsideAGroup) — so an
        // adjacent, otherwise-unrelated capturing local must still convert.
        let result = EmittedOracle.Evaluate(`func Run() int32 {
    var calls = 0
    let fact = func(n int32) int32 {
        calls = calls + 1
        if n <= 1 { return 1 }
        return n * fact(n - 1)
    }
    let logCalls = func() int32 { return calls }
    let callback () -> int32 = logCalls
    fact(5)
    return callback()
}
Run()`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(5, result.Value)
    }

    @Fact
    func GenericClassAndStructEncloser_CaptureFreeGroupAndMethodGroupConversion_CompilesAndRuns() {
        // Issue #4655: a capture-free non-generic local-function group inside
        // a member of a generic class or struct was mistakenly routed into a
        // `<lambda_host_*>` display class by ClosureEmitter (which only checked
        // `literal.Function.IsGeneric` instead of `LocalDeclaration != nil`),
        // skipping `<Program>` MethodDef planning and failing with GS9998.
        let result = EmittedOracle.Evaluate(`class Box[T] {
    func Run(n int32) int32 {
        let Even = func (k int32) bool { return k == 0 ? true : Odd(k - 1) }
        let Odd = func (k int32) bool { return k == 0 ? false : Even(k - 1) }
        return Even(n) ? 1 : 0
    }
    func EchoViaDelegate(value T) T {
        let First = func (x T, depth int32) T { return depth == 0 ? x : Second(x, depth - 1) }
        let Second = func (x T, depth int32) T { return First(x, depth) }
        let Pass = func (x T) T { return First(x, 1) }
        let fn (T) -> T = Pass
        return fn(value)
    }
}
struct SBox[T] {
    func Run(n int32) int32 {
        let Even = func (k int32) bool { return k == 0 ? true : Odd(k - 1) }
        let Odd = func (k int32) bool { return k == 0 ? false : Even(k - 1) }
        return Even(n) ? 10 : 20
    }
}
let s = SBox[int32]{}
Box[string]().Run(4) + s.Run(3) + Box[int32]().EchoViaDelegate(21)`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(42, result.Value)
    }

    @Theory
    @InlineData("let callback () -> int32 = Holder[int32].Secret\nreturn callback()", "GS0586")
    @InlineData("let nested = func() int32 { return 42 }\nreturn nested()", "GS0586")
    @InlineData(
        "var data = []int32{1}\nlet At = func(i int32) ref int32 { return ref data[i] }\nreturn At(0)",
        "GS0586"
    )
    @InlineData("var data = []int32{1}\nlet Read[U] = func(v U) int32 { return data[0] }\nreturn Read(1)", "GS0586")
    func GenericOwnerDependencies_InNonGenericGroup_FailBeforeEmission(body string, diagnostic string) {
        let result = EmittedOracle.Evaluate((`class Holder[Outer] {
    shared {
        private func Secret() int32 { return 42 }
        func Run() int32 {
            let first = func(x int32) int32 { return second(x) }
            let second = func(x int32) int32 { if x < 0 { return first(x) }; ` + "$body" + ` }
            return first(1)
        }
    }
}
Holder[string].Run()`))
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == diagnostic)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")
    }

    @Fact
    func GenericOwnerDependencies_WithEnclosingTypeParameterInSignature_StillReportsGS0586() {
        let result = EmittedOracle.Evaluate(`class Holder[Outer] {
    shared {
        private func Secret() int32 { return 42 }
        func Run(seed Outer) int32 {
            let first = func(x Outer, depth int32) int32 { return second(x, depth) }
            let second = func(x Outer, depth int32) int32 {
                if depth < 0 { return first(x, depth) }
                let callback () -> int32 = Holder[int32].Secret
                return callback()
            }
            return first(seed, 0)
        }
    }
}
Holder[string].Run("ok")`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0586")
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS9998")
    }

    @Fact
    func CapturingNonGenericGroupInGenericOwner_WithNestedLambda_CompilesAndRuns() {
        let result = EmittedOracle.Evaluate(`class Box[T] {
    func Run(data []int32) int32 {
        let first = func(i int32) int32 {
            let nested = func() int32 { return i }
            return second(nested())
        }
        let second = func(i int32) int32 {
            if i < 0 { return first(i) }
            return data[i]
        }
        return first(0)
    }
    func RunFunctionPointer() string {
        let First = func(n int32) string { return n <= 0 ? Second(0) : First(n - 1) }
        let Second = func(n int32) string { return n < 0 ? First(n) : typeof(T).Name }
        let Caller = func() string {
            unsafe {
                let fp = &First
                return fp(1)
            }
        }
        let CallerSibling = func() string { return Caller() }
        return CallerSibling()
    }
    func RunCapturingCallerOfPromotedDelegate[U](n int32) string {
        let First = func(k int32) string { return k <= 0 ? Second(0) : First(k - 1) }
        let Second = func(k int32) string { return k < 0 ? First(k) : typeof(U).Name }
        let Caller = func() string {
            let fn (int32) -> string = First
            return fn(n)
        }
        return Caller()
    }
}
class PlainBox {
    func RunFunctionPointer[U]() string {
        let First = func(n int32) string { return n <= 0 ? Second(0) : First(n - 1) }
        let Second = func(n int32) string { return n < 0 ? First(n) : typeof(U).Name }
        unsafe {
            let fp = &First
            return fp(1)
        }
    }
    func RunParentChildDelegate[U]() string {
        let First = func(k int32) string { return k <= 0 ? Second(0) : First(k - 1) }
        let Second = func(k int32) string { return k < 0 ? First(k) : typeof(U).Name }
        let Parent[P] = func(p P, n int32) string {
            let Child[V] = func(v V) string {
                let fn (int32) -> string = First
                return fn(n)
            }
            return Child(p)
        }
        return Parent(0, 1)
    }
    func RunCapturingIterator[U](prefix string) string {
        let First = func(k int32) string { return k <= 0 ? Second(0) : First(k - 1) }
        let Second = func(k int32) string { return k < 0 ? First(k) : typeof(U).Name }
        let Iter = func() sequence[string] {
            yield prefix + First(1)
        }
        for s in Iter() {
            return s
        }
        return ""
    }
}
"${Box[string]().Run([]int32{42})}:${Box[string]().RunFunctionPointer()}:${Box[string]().RunCapturingCallerOfPromotedDelegate[int32](1)}:${PlainBox().RunFunctionPointer[int32]()}:${PlainBox().RunParentChildDelegate[string]()}:${PlainBox().RunCapturingIterator[string]("iter:")}"`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("42:String:Int32:Int32:String:iter:String", result.Value)
    }
}
