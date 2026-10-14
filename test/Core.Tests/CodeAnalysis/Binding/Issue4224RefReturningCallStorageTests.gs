// <copyright file="Issue4224RefReturningCallStorageTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import System.Linq
import Xunit

/// Issue #4224: a call to a native (same-compilation) ref-returning
/// function/method, or a read of a native ref-returning property/indexer, is
/// now usable as ref-aliasing local storage (`var ref`/`let ref`),
/// as the operand of `return ref`, and — when its getter is writable
/// (`ref`, not `ref readonly`) and there is no setter — as an
/// assignment target, storing through the getter's managed pointer instead of
/// inventing a setter. (cref:GSharp.Core.CodeAnalysis.Binding.RefCapabilities)
/// carries the shared classification (`IsNativeRefReturningCall`,
/// `TryGetRefReturnEscapeSources`) that `ExpressionBinder.IsLvalue`,
/// `StatementBinder.IsLvalueForRefReturn`, and
/// `StatementBinder.HasFunctionLocalRefScope` all consume, so a genuine
/// escape of function-local storage through a forwarding ref-returning call
/// is still rejected with GS0254 exactly as it always was.
open class Issue4224RefReturningCallStorageTests {
    @Fact
    func AliasFromRefReturningFunctionCall_MutatesOriginalArrayElement() {
        let result = EmittedOracle.Evaluate(`func At(values []int32, index int32) ref int32 {
    return ref values[index]
}
func Run() int32 {
    var values = []int32{10}
    var ref alias = At(values, 0)
    alias = 42
    return values[0]
}
var answer = Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.ReadGlobals()["answer"])
    }

    @Fact
    func ReturnRef_ForwardingARefReturningCall_PreservesIdentity() {
        let result = EmittedOracle.Evaluate(`func At(values []int32, index int32) ref int32 {
    return ref values[index]
}
func Forward(values []int32) ref int32 {
    return ref At(values, 0)
}
func Run() int32 {
    var values = []int32{10}
    var ref alias = Forward(values)
    alias = 77
    return values[0]
}
var answer = Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(77, result.ReadGlobals()["answer"])
    }

    @Fact
    func ReturnRef_ForwardingCallerOwnedAliasThroughARefParameter_PreservesIdentity() {
        // The issue's own repro: the alias's storage is the CALLER's `value`,
        // not the alias slot itself — this must not report GS0254.
        let result = EmittedOracle.Evaluate(`func Forward(ref value int32) ref int32 {
    var ref alias = value
    return ref alias
}
func Run() int32 {
    var value = 42
    return Forward(ref value)
}
var answer = Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.ReadGlobals()["answer"])
    }

    @Fact
    func ReturnRef_ForwardingARefParameterThroughANestedRefReturningCall_PreservesIdentity() {
        let result = EmittedOracle.Evaluate(`func Fwd(ref v int32) ref int32 {
    return ref v
}
func UseFwd(ref v int32) ref int32 {
    return ref Fwd(ref v)
}
func Run() int32 {
    var x = 5
    var ref alias = UseFwd(ref x)
    alias = 9
    return x
}
var answer = Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(9, result.ReadGlobals()["answer"])
    }

    @Fact
    func ReturnRef_ForwardingARefArgumentBoundToAFunctionLocal_ReportsGS0254() {
        // Fwd(ref x) legitimately returns a ref to the caller's `x` — but that
        // "caller" is Bad's own function-local `x`, so returning it further up
        // must still be rejected: the ref-call escape computation must not
        // treat a ref/in argument as unconditionally safe.
        let result = EmittedOracle.Evaluate(`func Fwd(ref v int32) ref int32 {
    return ref v
}
func Bad() ref int32 {
    var x = 1
    return ref Fwd(ref x)
}`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0254")
    }

    @Fact
    func ReturnRef_ForwardingAnAliasOfARefArgumentBoundToAFunctionLocal_ReportsGS0254() {
        let result = EmittedOracle.Evaluate(`func Fwd(ref v int32) ref int32 {
    return ref v
}
func Bad() ref int32 {
    var x = 1
    var ref a = Fwd(ref x)
    return ref a
}`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0254")
    }

    @Fact
    func AliasFromGenericRefReturningFunctionCall_MutatesOriginalArrayElement() {
        let result = EmittedOracle.Evaluate(`func At[T](values []T, index int32) ref T {
    return ref values[index]
}
func Run() int32 {
    var values = []int32{1, 2, 3}
    var ref alias = At(values, 1)
    alias = 99
    return values[1]
}
var answer = Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(99, result.ReadGlobals()["answer"])
    }

    @Fact
    func WritableRefReturningCall_AssignmentAndPostfixIncrement_EvaluateCallOnce() {
        let result = EmittedOracle.Evaluate(`func At(values []int32, index int32) ref int32 {
    calls++
    return ref values[index]
}
func Run() int32 {
    var values = []int32{10}
    At(values, 0) = 41
    let prior = At(values, 0)++
    return values[0] * 100 + prior * 10 + calls
}
var calls = 0
var answer = Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(4612, result.ReadGlobals()["answer"])
    }

    @Fact
    func WritableRefReturningCall_AssignmentUsesConstantNarrowing() {
        let result = EmittedOracle.Evaluate(`func At(values []uint8) ref uint8 {
    return ref values[0]
}
func Run() uint8 {
    var values = []uint8{0}
    At(values) = 1
    return values[0]
}
var answer = Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(uint8(1), result.ReadGlobals()["answer"])
    }

    @Fact
    func WritableRefReturningCall_IncrementUsesUserCompoundOperator() {
        let result = EmittedOracle.Evaluate(`class Bag {
    var total int32
    prop Total int32 { get { return total } }
    func operator +=(amount int32) { total = total + amount }
}
func Forward(ref value Bag) ref Bag {
    calls++
    return ref value
}
func Run() int32 {
    var bag = Bag()
    let previous = Forward(ref bag)++
    return bag.Total * 10 + calls
}
var calls = 0
var answer = Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(11, result.ReadGlobals()["answer"])
    }

    @Theory
    @InlineData("At(values, 0) = await Task.FromResult(1)")
    @InlineData("At(values, 0) += await Task.FromResult(1)")
    func WritableRefReturningCall_SuspendingRhsIsRejected(assignment string) {
        let result = EmittedOracle.Evaluate((`import System.Threading.Tasks
func At(values []int32, index int32) ref int32 {
    return ref values[index]
}
async func Bad() int32 {
    var values = []int32{0}
    ` + "$assignment" + `
    return values[0]
}`))
        Assert.Contains(
            result.Diagnostics,
            (diagnostic Diagnostic) -> diagnostic.Id == "GS0604" && diagnostic.Message.Contains(
                "cannot survive suspension",
                StringComparison.Ordinal
            )
        )
    }

    @Fact
    func WritableRefReturningProperty_CompoundSuspendingRhsIsRejected() {
        let result = EmittedOracle.Evaluate((`import System.Threading.Tasks
class Holder {
    var values []int32
    prop Value ref int32 { get { return ref values[0] } }
    func Init() { values = []int32{0} }
}
async func Bad() int32 {
    var holder = Holder{}
    holder.Init()
    holder.Value += await Task.FromResult(1)
    return holder.Value
}`))
        Assert.Contains(
            result.Diagnostics,
            (diagnostic Diagnostic) -> diagnostic.Id == "GS0604" && diagnostic.Message.Contains(
                "cannot survive suspension",
                StringComparison.Ordinal
            )
        )
    }

    @Fact
    func ImportedWritableRefReturningCall_AssignmentAndIncrementMutateReferent() {
        let result = EmittedOracle.Evaluate(`import System

func Run() int32 {
    var values = []int32{10}
    var span = Span[int32](values)
    span.GetPinnableReference() = 20
    span.GetPinnableReference()++
    return values[0]
}
var answer = Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(21, result.ReadGlobals()["answer"])
    }

    @Fact
    func ReadOnlyRefReturningCall_RemainsProtectedFromDirectAssignment() {
        let result = EmittedOracle.Evaluate(`func View(values []int32) ref readonly int32 {
    return ref values[0]
}
func Run() {
    var values = []int32{10}
    View(values) = 20
}`)
        Assert.Contains(
            result.Diagnostics,
            (diagnostic Diagnostic) -> diagnostic.Message.Contains(
                "readonly storage cannot be written through",
                StringComparison.OrdinalIgnoreCase
            )
        )
    }

    @Fact
    func BaseClassRefReturningCall_AssignmentAndIncrementMutateBaseStorage() {
        let result = EmittedOracle.Evaluate(`open class Base {
    var values []int32 = []int32{10}
    open func At(index int32) ref int32 { return ref values[index] }
}
class Derived : Base {
    func Run() int32 {
        base.At(0) = 20
        base.At(0)++
        return base.At(0)
    }
}
var answer = Derived{}.Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(21, result.ReadGlobals()["answer"])
    }

    @Fact
    func BaseInterfaceRefReturningCall_AssignmentAndIncrementMutateArgument() {
        let result = EmittedOracle.Evaluate(`interface IRef {
    func First(values []int32) ref int32 { return ref values[0] }
}
class Holder : IRef {
    func Run() int32 {
        var values = []int32{10}
        base[IRef].First(values) = 20
        base[IRef].First(values)++
        return values[0]
    }
}
var answer = Holder{}.Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(21, result.ReadGlobals()["answer"])
    }

    @Fact
    func AliasFromImportedRefIndexer_StillMutatesOriginalArrayElement() {
        // Not a new code path — ConversionClassifier.AutoDereferenceRefReturn
        // already wraps an imported/CLR ref-returning member's read in a
        // BoundDereferenceExpression, which was already an lvalue. Regression
        // coverage for the issue's "imported APIs" Definition-of-Done bullet.
        let result = EmittedOracle.Evaluate(`import System

func Run() int32 {
    var values = []int32{10, 20, 30}
    var span = Span[int32](values)
    var ref alias = span[0]
    alias = 42
    return values[0]
}
var answer = Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.ReadGlobals()["answer"])
    }

    @Fact
    func PropertyAlias_MutatesOriginalField_AndPropertyAssignmentStoresThroughGetter() {
        let result = EmittedOracle.Evaluate(`class Holder {
    var slot int32 = 10
    prop Value ref int32 { get { return ref slot } }
}
func Run() int32 {
    var holder = Holder{}
    var ref alias = holder.Value
    alias = 42
    var afterAlias = holder.slot
    holder.Value = 99
    return afterAlias * 1000 + holder.slot
}
var answer = Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42099, result.ReadGlobals()["answer"])
    }

    @Fact
    func PropertyAssignment_ThroughChainedSideEffectingReceiver_EvaluatesReceiverExactlyOnce() {
        let result = EmittedOracle.Evaluate(`class Holder {
    var slot int32 = 10
    prop Value ref int32 { get { return ref slot } }
}
func GetHolder(h Holder) Holder {
    getCount = getCount + 1
    return h
}
func Run() int32 {
    var h = Holder{}
    GetHolder(h).Value = 7
    return h.slot * 100 + getCount
}
var getCount = 0
var answer = Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(701, result.ReadGlobals()["answer"])
    }

    @Fact
    func WritableRefGetter_IncrementAndDecrementWriteThroughBareAndQualifiedTargets() {
        let result = EmittedOracle.Evaluate(`class Holder {
    var slot int32 = 10
    var calls int32
    prop Value ref int32 {
        get {
            calls++
            return ref slot
        }
    }
    func Run() bool {
        let barePrevious = Value++
        let qualifiedPrevious = this.Value--
        let updated = ++Value
        return barePrevious == 10 &&
            qualifiedPrevious == 11 &&
            updated == 11 &&
            slot == 11 &&
            calls == 3
    }
}
var answer = Holder{}.Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.ReadGlobals()["answer"])
    }

    @Fact
    func ReadOnlyRefGetter_StaysProtectedFromWrites() {
        let result = EmittedOracle.Evaluate(`class Holder {
    var slot int32 = 10
    prop Value ref readonly int32 { get { return ref slot } }
}
func Run() {
    var holder = Holder{}
    holder.Value = 99
}`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0127")
    }

    @Fact
    func VarRefAlias_OfWritableGetter_OnReadOnlyStructReceiver_AliasesHeapStorage() {
        // ADR-0187 / issue #4350 (C#'s scoped-`this` rule): the receiver is
        // defensively copied to call the getter, but a non-@UnscopedRef getter
        // cannot return into that copy, so the alias names `data[0]` itself.
        let result = EmittedOracle.Evaluate(`struct Holder {
    var data []int32
    prop Value ref int32 { get { return ref data[0] } }
}
func Run() int32 {
    let h = Holder{ data: []int32{10} }
    var ref alias = h.Value
    alias = 77
    return h.data[0]
}
var answer = Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(77, result.ReadGlobals()["answer"])
    }

    @Fact
    func Assignment_ThroughWritableGetter_OnReadOnlyStructReceiver_WritesHeapStorage() {
        let result = EmittedOracle.Evaluate(`struct Holder {
    var data []int32
    prop Value ref int32 { get { return ref data[0] } }
}
func Run() int32 {
    let h = Holder{ data: []int32{10} }
    h.Value = 55
    return h.data[0]
}
var answer = Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(55, result.ReadGlobals()["answer"])
    }

    @Fact
    func Assignment_ThroughUnscopedRefGetter_OnReadOnlyStructReceiver_IsRejected() {
        // An @UnscopedRef getter CAN return into its receiver, so writing
        // through a copied receiver would be lost: still rejected.
        let result = EmittedOracle.Evaluate(`import System.Diagnostics.CodeAnalysis
struct Holder {
    var total int32

    @UnscopedRef
    prop Value ref int32 { get { return ref this.total } }
}
func Run() {
    let h = Holder{ total: 10 }
    h.Value = 55
}`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0499")
    }

    @Fact
    func LetRefReadOnlyAlias_OfWritableGetter_OnReadOnlyStructReceiver_IsPermitted() {
        // A READ-ONLY view is always safe to take, even from a defensively
        // copied receiver.
        let result = EmittedOracle.Evaluate(`struct Holder {
    var data []int32
    prop Value ref int32 { get { return ref data[0] } }
}
func Run() int32 {
    let h = Holder{ data: []int32{10} }
    let ref readonly alias = h.Value
    return alias
}
var answer = Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(10, result.ReadGlobals()["answer"])
    }

    @Fact
    func StructReceiver_PropertyAssignmentAndAlias_MutateOriginalStorage() {
        let result = EmittedOracle.Evaluate(`struct Holder {
    var data []int32
    prop Value ref int32 { get { return ref data[0] } }
}
func Run() int32 {
    var h = Holder{ data: []int32{10} }
    h.Value = 55
    var afterAssign = h.data[0]
    var ref alias = h.Value
    alias = 66
    return afterAssign * 1000 + h.data[0]
}
var answer = Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(55066, result.ReadGlobals()["answer"])
    }

    @Fact
    func NativeIndexer_AliasAndAssignment_MutateOriginalArrayElement() {
        let result = EmittedOracle.Evaluate(`class Box {
    var values []int32 = []int32{40, 2}
    prop this[i int32] ref int32 { get { return ref values[i] } }
}
func Run() int32 {
    var box = Box{}
    var ref alias = box[1]
    alias = 99
    var afterAlias = box.values[1]
    box[1] = 7
    return afterAlias * 1000 + box.values[1]
}
var answer = Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(99007, result.ReadGlobals()["answer"])
    }
}
