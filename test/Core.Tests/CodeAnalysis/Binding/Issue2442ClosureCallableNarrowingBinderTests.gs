// <copyright file="Issue2442ClosureCallableNarrowingBinderTests.cs" company="GSharp">
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
import Xunit

/// ADR-0069 amendment / issue #2442 — a nil-guard's smart-cast narrowing on a
/// <em>read-only, plain-variable</em> binding (a `let` local or a
/// by-value/`in` function parameter) now survives into a captured
/// lambda or local-function body, instead of being unconditionally cleared
/// the way every other narrowing (mutable `var` locals, `ref`/
/// `out` parameters, member-access paths) still is.
/// @remarks The bug's original fingerprint (Oahu's `DownloadDecryptJob`) is a
/// nullable, <em>named</em> G# delegate type
/// (`delegate X(...) ...`) invoked via direct call syntax;
/// inside `Task.Run(() -> ...)`. A bare native G# arrow function type
/// (`(...) -> ...)?`) or an imported CLR generic delegate
/// (`System.Func<...>`/`Action<...>`) both erase to a
/// real CLR delegate (cref:System.Type) at the
/// `NullableTypeSymbol`/`FunctionTypeSymbol` level, so
/// Both named and imported delegate shapes are covered below. Invalidated
/// nullable named-delegate calls report GS0503, matching imported delegates.
open class Issue2442ClosureCallableNarrowingBinderTests {
    // ---- Positive: the exact reported shape -------------------------------
    @Fact
    func DownloadDecryptJobShape_NamedDelegateField_NarrowsInsideTaskRunClosure() {
        let result = Evaluate(`
import System
import System.Collections.Generic
import System.Threading.Tasks
` + NamedDelegate + `
class DownloadDecryptJob {
    var runningTasks List[Task] = List[Task]()

    func Convert(data []uint8, convertAction ConvertFunc?) {
        if convertAction != nil {
            runningTasks.Add(Task.Run(() -> {
                let result = convertAction(data)
            }))
        }
    }
}
`)
        AssertClean(result)
    }

    @Fact
    func LetParameter_NamedDelegate_DirectInvokeInsideArrowLambda() {
        let result = Evaluate(NamedDelegate + `
func Run(convertAction ConvertFunc?, data []uint8) {
    if convertAction != nil {
        let f = () -> { convertAction(data) }
        f()
    }
}
Run(nil, []uint8{})
`)
        AssertClean(result)
    }

    @Fact
    func ByValueParameter_NarrowsInsideLocalFunction() {
        // A local function is a `let Name = func() { ... }` function-literal
        // declaration — its captured-variable analysis goes through the same
        // BindFunctionLiteralExpression entry point as an ordinary lambda.
        let result = Evaluate(NamedDelegate + `
func Run(convertAction ConvertFunc?, data []uint8) {
    if convertAction != nil {
        let Inner = func() {
            convertAction(data)
        }
        Inner()
    }
}
Run(nil, []uint8{})
`)
        AssertClean(result)
    }

    @Fact
    func LetLocal_CopiedFromParameter_NarrowsInsideClosure() {
        let result = Evaluate(NamedDelegate + `
func Run(convertActionIn ConvertFunc?, data []uint8) {
    let convertAction = convertActionIn
    if convertAction != nil {
        let f = () -> { convertAction(data) }
        f()
    }
}
Run(nil, []uint8{})
`)
        AssertClean(result)
    }

    // ---- Positive: closure execution/lifetime shapes ----------------------
    @Fact
    func NestedLambdas_InnerClosureStillSeesNarrowing() {
        let result = Evaluate(NamedDelegate + `
func Run(convertAction ConvertFunc?, data []uint8) {
    if convertAction != nil {
        let outer = () -> {
            let inner = () -> { convertAction(data) }
            inner()
        }
        outer()
    }
}
Run(nil, []uint8{})
`)
        AssertClean(result)
    }

    @Fact
    func MultipleClosures_CapturingSameReadOnlyBinding_BothNarrow() {
        let result = Evaluate(NamedDelegate + `
func Run(convertAction ConvertFunc?, data []uint8) {
    if convertAction != nil {
        let f1 = () -> { convertAction(data) }
        let f2 = () -> { convertAction(data) }
        f1()
        f2()
    }
}
Run(nil, []uint8{})
`)
        AssertClean(result)
    }

    @Fact
    func EscapingClosure_ReturnedFromDeclaringFunction_StillNarrows() {
        // The closure runs strictly after the declaring function has
        // returned — the read-only rule must hold across that boundary too,
        // since a `let`/by-value parameter cannot be reassigned regardless
        // of when or how many times the escaping delegate is later invoked.
        let result = Evaluate(NamedDelegate + `
func Make(convertAction ConvertFunc?, data []uint8) (() -> void)? {
    if convertAction != nil {
        return () -> { convertAction(data) }
    }
    return nil
}
let f = Make(nil, []uint8{})
`)
        AssertClean(result)
    }

    @Fact
    func AsyncLambda_NarrowsAcrossAwaitSuspension() {
        let result = Evaluate(`
import System.Threading.Tasks
` + NamedDelegate + `
func Run(convertAction ConvertFunc?, data []uint8) {
    if convertAction != nil {
        let task = Task.Run(async () -> {
            await Task.Delay(1)
            convertAction(data)
        })
    }
}
Run(nil, []uint8{})
`)
        AssertClean(result)
    }

    @Fact
    func ConditionalInvocation_InsideClosureBody_StillNarrows() {
        let result = Evaluate(NamedDelegate + `
func Run(convertAction ConvertFunc?, data []uint8, flag bool) {
    if convertAction != nil {
        let f = () -> {
            if flag {
                convertAction(data)
            }
        }
        f()
    }
}
Run(nil, []uint8{}, true)
`)
        AssertClean(result)
    }

    @Fact
    func NestedBranch_NarrowingEstablishedInInnerIf_SurvivesClosure() {
        let result = Evaluate(NamedDelegate + `
func Run(convertAction ConvertFunc?, data []uint8, flag bool) {
    if flag {
        if convertAction != nil {
            let f = () -> { convertAction(data) }
            f()
        }
    }
}
Run(nil, []uint8{}, true)
`)
        AssertClean(result)
    }

    @Fact
    func GenericNamedDelegate_NarrowsInsideClosure() {
        let result = Evaluate(`
delegate Transform[T any](v T) T;
func Run[T](a Transform[T]?, v T) T {
    if a != nil {
        let f = () -> { return a(v) }
        return f()
    }
    return v
}
Run[int32](nil, 1)
`)
        AssertClean(result)
    }

    // ---- Positive: coverage for bare function types and CLR delegates -----
    //
    // These shapes remain regression coverage for valid closure narrowing.
    @Fact
    func BareNullableFunctionType_NarrowsInsideClosure() {
        let result = Evaluate(`
func Run(convertAction (([]uint8) -> []uint8)?, data []uint8) {
    if convertAction != nil {
        let f = () -> { convertAction(data) }
        f()
    }
}
Run(nil, []uint8{})
`)
        AssertClean(result)
    }

    @Fact
    func ClrGenericDelegate_NarrowsInsideClosure() {
        let result = Evaluate(`
import System
func Run(convertAction Func[[]uint8, []uint8]?, data []uint8) {
    if convertAction != nil {
        let f = () -> { convertAction(data) }
        f()
    }
}
Run(nil, []uint8{})
`)
        AssertClean(result)
    }

    // ---- Negative: mutation, aliasing, and member-path cases must still
    //      drop the narrowing (unsound to preserve) --------------------------
    @Fact
    func MutableVarLocal_ReassignedBeforeClosureCreation_DoesNotNarrow() {
        let result = Evaluate(NamedDelegate + `
func Run(convertActionIn ConvertFunc?, data []uint8) {
    var convertAction = convertActionIn
    if convertAction != nil {
        convertAction = nil
        let f = () -> { convertAction(data) }
        f()
    }
}
Run(nil, []uint8{})
`)
        AssertContainsError(result, "GS0503")
    }

    @Fact
    func MutableVarLocal_ReassignedAfterClosureCreation_DoesNotNarrow() {
        // The closure is created while `convertAction` is still narrowed,
        // but the enclosing scope reassigns it before the closure actually
        // runs — exactly the hazard ADR-0069 exists to prevent for mutable
        // bindings. `var` is not `IsReadOnly`, so the fix's filter still
        // drops this narrowing, unchanged from pre-#2442 behavior.
        let result = Evaluate(NamedDelegate + `
func Run(convertActionIn ConvertFunc?, data []uint8) {
    var convertAction = convertActionIn
    if convertAction != nil {
        let f = () -> { convertAction(data) }
        convertAction = nil
        f()
    }
}
Run(nil, []uint8{})
`)
        AssertContainsError(result, "GS0503")
    }

    @Fact
    func MutableVarLocal_ReassignedAcrossLoopIterations_DoesNotNarrow() {
        let result = Evaluate(NamedDelegate + `
func Run(convertActionIn ConvertFunc?, data []uint8) {
    var convertAction = convertActionIn
    for i in 0...3 {
        if convertAction != nil {
            let f = () -> { convertAction(data) }
            f()
        }
        convertAction = nil
    }
}
Run(nil, []uint8{})
`)
        AssertContainsError(result, "GS0503")
    }

    @Fact
    func RefParameter_DoesNotNarrow() {
        // A `ref` parameter aliases external, possibly-shared storage; it is
        // not `IsReadOnly` (RefKind != None/In), so it is excluded by the
        // same filter that already excludes `var` locals.
        let result = Evaluate(NamedDelegate + `
func Run(ref convertAction ConvertFunc?, data []uint8) {
    if convertAction != nil {
        let f = () -> { convertAction(data) }
        f()
    }
}
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.IsError)
    }

    @Fact
    func MemberAccessPath_ClassFieldNarrowing_DoesNotSurviveClosure() {
        // Member paths are always dropped across a closure boundary, even
        // when the receiver and field are both otherwise stable/read-only —
        // this mirrors the ADR-1180 member-path addendum: a member read
        // could be mutated through an alias the narrowing analysis never
        // observes, so widening the "read-only survives" rule to member
        // paths would be unsound.
        let result = Evaluate(NamedDelegate + `
class Box {
    let convertAction ConvertFunc?
}
func Run(box Box, data []uint8) {
    if box.convertAction != nil {
        let f = () -> { box.convertAction(data) }
        f()
    }
}
Run(Box{convertAction: nil}, []uint8{})
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.IsError)
    }

    shared {
        private const NamedDelegate string = "delegate ConvertFunc(data []uint8) []uint8;\n"

        private func AssertClean(result EmittedOracleResult) {
            Assert.Empty(result.Diagnostics)
        }

        private func AssertContainsError(result EmittedOracleResult, diagnosticId string) {
            Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.IsError && d.Id == diagnosticId)
        }

        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
