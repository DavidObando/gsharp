// <copyright file="Issue3501RefKindFunctionLiteralTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System.Linq
import Xunit

/// Issue #3501 Track A2: function literals and native function types carry
/// ADR-0060 `ref`/`out`/`in` parameters with the same
/// semantics as declared functions. `System.Func`/`Action` cannot
/// represent by-ref type arguments, so such shapes bind to a
/// compiler-synthesized delegate (one per distinct shape, emitted through
/// the ADR-0059 named-delegate path); previously a ref-kind literal without
/// a named-delegate target failed with a same-display GS0155.
open class Issue3501RefKindFunctionLiteralTests {
    @Fact
    func RefLiteral_InfersSynthesizedDelegate_AndMutatesThroughRef() {
        let source = `
func Run() int32 {
    let bump = func(ref n int32) {
        n = n + 1
    }
    var x = 41
    bump(ref x)
    return x
}

Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(42, result.Value)
    }

    @Fact
    func OutAndInLiterals_WorkThroughInferredTypes() {
        let source = `
func Run() int32 {
    let tryGet = func(out v int32) bool {
        v = 7
        return true
    }
    var total = 0
    if tryGet(out var got) {
        total += got
    }
    let reader = func(in v int32) int32 {
        return v * 2
    }
    var src = 21
    total += reader(&src)
    return total
}

Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(49, result.Value)
    }

    @Fact
    func RefFunctionTypeClause_InParameterPosition_AcceptsLiteralArgument() {
        let source = `
func apply(f (ref int32) -> void) int32 {
    var x = 41
    f(ref x)
    return x
}

func Run() int32 {
    return apply(func(ref n int32) {
        n = n + 1
    })
}

Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(42, result.Value)
    }

    @Fact
    func RefFunctionTypeClause_InReturnPosition_RoundTrips() {
        let source = `
func makeDouble() (ref int32) -> void {
    return func(ref n int32) {
        n = n * 2
    }
}

func Run() int32 {
    let f = makeDouble()
    var x = 21
    f(ref x)
    return x
}

Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(42, result.Value)
    }

    @Fact
    func NullableRefFunctionType_AssignsAndInvokesWithAssertion() {
        let source = `
func Run() int32 {
    var acc ((ref int32) -> void)? = nil
    acc = func(ref n int32) {
        n = n + 10
    }
    var y = 1
    acc!!(ref y)
    return y
}

Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(11, result.Value)
    }

    @Fact
    func SelfReferencingRefLiteral_Recurses() {
        let source = `
func Run() int32 {
    let countdown = func(ref n int32) {
        if n > 0 {
            n = n - 1
            countdown(n: ref n)
        }
    }
    var x = 5
    countdown(n: ref x)
    return x
}

Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(0, result.Value)
    }

    @Fact
    func SameShape_UnifiesToOneSynthesizedDelegate() {
        // Two spellings of the same shape are the same symbol within one
        // compile pass, so a literal bound through one clause assigns to a
        // slot declared through the other.
        let source = `
func apply(f (ref int32) -> void, seed int32) int32 {
    var x = seed
    f(ref x)
    return x
}

func Run() int32 {
    let g ((ref int32) -> void) = func(ref n int32) {
        n = n + 1
    }
    return apply(g, 41)
}

Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(42, result.Value)
    }

    @Fact
    func NamedDelegateTarget_StillBindsDirectly() {
        // The delegate declaration is spelled AFTER `func Run` because a
        // void-returning `delegate func(...)` greedily consumes a following
        // `func` keyword as its return-type clause (pre-existing parse
        // greediness, unrelated to this issue).
        let source = `
func Run() int32 {
    let bump BumpShape = func(ref n int32) {
        n = n + 1
    }
    var x = 41
    bump(ref x)
    return x
}

Run()

delegate BumpShape(ref n int32);
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ArrowLambda_InRefOutParameters_InfersSynthesizedDelegate_AndTargetTypes() {
        let source = `
import System
import System.Collections.Generic

delegate NamedInOp(in x int32) int32;
delegate GenericInOp[T](in x T) T;

class GenericInCtorBox[T] {
    var Callback GenericInOp[T]

    init(cb GenericInOp[T]) {
        Callback = cb
    }
}

func apply(cb (in int32) -> int32, v int32) int32 {
    return cb(v)
}

func useGenericNamedInDelegate[T](v T) T {
    let f GenericInOp[T] = func(in x T) T {
        return x
    }
    let g GenericInOp[T] = (in x T) -> x
    let h = (in x T) -> x
    let throwIn = (in x T) -> throw InvalidOperationException("${x}")
    let throwInWithVal = (in x T, y T) -> throw InvalidOperationException("${x}|${y}")
    try {
        throwIn(v)
    } catch (InvalidOperationException) {
    }
    try {
        throwInWithVal(v, v)
    } catch (InvalidOperationException) {
    }
    return h(g(f(v)))
}

func Run() int32 {
    var f = (in value int32) -> value + 1
    var bump = (ref value int32) -> {
        value = value + 10
    }
    var fill = (out value int32) -> {
        value = 7
        return true
    }
    var sub1 = (in x int32, in y int32) -> x - y
    var sub2 = (in y int32, in x int32) -> y - x
    let swappedTuple = ((in x int32, in y int32) -> x - y, (in y int32, in x int32) -> y - x)
    let widenedTuple ((in int32, in int32) -> int32, (in int32, in int32) -> int32) = swappedTuple
    let rawForWiden = ((in y int32, in x int32) -> y - x, 1)
    let widenedWithInt64 ((in int32, in int32) -> int32, int64) = rawForWiden
    let nestedSwappedTuple = (((in x int32, in y int32) -> x - y, (in y int32, in x int32) -> y - x), 0)
    let (deconF, deconG) = swappedTuple
    let (nestedInner, _) = nestedSwappedTuple
    let (_, nestedDeconG) = nestedInner
    let blockSub = {
        let bias = 0
        (in y int32, in x int32) -> y - x + bias
    }
    let deferSub = {
        defer apply(f, 0)
        (in y int32, in x int32) -> y - x
    }
    let makeNested = (in ignored int32) -> (in value int32) -> value + 1
    let getSwapped = () -> {
        (in y int32, in x int32) -> y - x
    }
    let getLoopSwapped = () -> {
        for {
            return (in y int32, in x int32) -> y - x
        }
    }
    let ifSwapped = if true {
        (in y int32, in x int32) -> y - x
    } else {
        (in y int32, in x int32) -> y - x
    }
    let nullableBlockNamedTuple ((NamedInOp, int32)?, int32) = ({
        ((in x) -> x + 7, 1)
    }, 2)
    let genericCtorBox = GenericInCtorBox[int32]((in x int32) -> x + 3)
    let namedSeed NamedInOp = (in x int32) -> x + 2
    let ternaryNamed = true ? namedSeed : ((in x int32) -> x + 1)
    let switchNamed = switch 1 {
        case 0: (in x int32) -> x + 1
        default: namedSeed
    }
    let switchSwapped = switch 0 {
        case 0: (in y int32, in x int32) -> y - x
        default: (in y int32, in x int32) -> y - x
    }
    var deferCleanupCount = 0
    let markCleanup = () -> { deferCleanupCount += 1 }
    let deferIfNamed = if true {
        defer markCleanup()
        (in x int32) -> x + 1
    } else {
        namedSeed
    }
    let ternaryNil = true ? ((in x int32) -> x + 1) : nil
    let switchNil = switch 0 {
        case 0: (in x int32) -> x + 2
        default: nil
    }
    let contravariantVal1 = true ? ((in n int32, x object) -> n + 1) : ((in n int32, x string) -> n + x.Length)
    let contravariantVal2 = false ? ((in n int32, x string) -> n + x.Length) : ((in n int32, x object) -> n + 1)
    let switchContravariantVal = switch 0 {
        case 0: (in n int32, x object) -> n + 1
        default: (in n int32, x string) -> n + x.Length
    }
    let makeNamedOrLiteral1 = (c bool) -> {
        if c {
            return (in x int32) -> x + 1
        }
        return namedSeed
    }
    let makeNamedOrLiteral2 = (c bool) -> {
        if c {
            return namedSeed
        }
        return (in x int32) -> x + 1
    }
    let makeWithDefer = () -> {
        defer markCleanup()
        (in y int32, in x int32) -> y - x
    }
    let gotFromDefer = makeWithDefer()
    let mergedOuterTernary = true ? ((in value int32) -> (in left int32) -> left) : ((in value int32) -> (in right int32) -> right)
    let mergedOuterSwitch = switch 0 {
        case 0: (in value int32) -> (in left int32) -> left
        default: (in value int32) -> (in right int32) -> right
    }
    let makeMergedOuter = (c bool) -> {
        if c {
            return (in value int32) -> (in left int32) -> left
        }
        return (in value int32) -> (in right int32) -> right
    }
    let gotMergedOuter = makeMergedOuter(true)
    var listForThrow = List[int32](){1}
    let throwWithClrIndexer = (ref xs List[int32]) -> throw InvalidOperationException((xs[0] = 7).ToString())
    var assignedNamed NamedInOp = namedSeed
    assignedNamed = true ? ((in x int32) -> x + 1) : ((in x int32) -> x + 2)
    let nestedThrowOpt = () -> {
        defer markCleanup()
        (in x int32, y int32 = 5) -> throw InvalidOperationException("${x}|${y}")
    }
    let gotSwapped = getSwapped()
    var opt1 = (in x int32, y int32 = 1) -> x + y
    var opt2 = (in x int32, y int32 = 2) -> x + y
    var strOpt1 = (in x int32, a string = "a;0:!clrN=System.String:b", b string = "c") -> "${a}|${b}"
    var strOpt2 = (in x int32, a string = "a", b string = "b;0:!clrN=System.String:c") -> "${a}|${b}"
    let typed (in int32) -> int32 = (in x) -> x * 2
    let blockLambda = {
        let delta = 3
        (in x int32) -> x + delta
    }
    let blockThrowLambda = {
        let _ = 0
        (in x int32) -> throw InvalidOperationException("${x}")
    }
    let (tupleLambda, bias) = ((in x int32) -> x + 5, 2)
    let (tupleThrowLambda, throwBias) = ((in x int32) -> throw InvalidOperationException("${x}"), 5)
    let namedTuple (NamedInOp, int32) = ((in x int32) -> x + 6, 3)
    let namedUntypedTuple (NamedInOp, int32) = ((in x) -> x + 8, 4)
    let parensNamedTuple (NamedInOp, int32) = (((in x) -> x + 9), 5)
    let outerParensNamedTuple (NamedInOp, int32) = (((in x) -> x + 1, 2))
    let blockNamedTuple (NamedInOp, int32) = ({
        let k = 10
        (in x) -> x + k
    }, 6)
    var objTuple (object, int32) = ("", 0)
    objTuple = ((in x int32) -> x, 5)
    let direct = ((in x int32) -> x * 3)(14)
    var caught = 0
    try {
        blockThrowLambda(1)
    } catch (InvalidOperationException) {
        caught += 1
    }
    try {
        tupleThrowLambda(throwBias)
    } catch (InvalidOperationException) {
        caught += 2
    }
    try {
        ((in x int32) -> throw InvalidOperationException("${x}"))(9)
    } catch (InvalidOperationException) {
        caught += 4
    }
    try {
        throwWithClrIndexer(ref listForThrow)
    } catch (InvalidOperationException) {
        caught += listForThrow[0]
    }
    try {
        nestedThrowOpt()(1)
    } catch (InvalidOperationException) {
        caught += 3
    }
    var a = 4
    bump(ref a)
    var total = f(in a) + f(a) + f(41) + typed(a) + blockLambda(a) + tupleLambda(bias) + direct + apply((in x) -> x + 4, 38)
    total += sub1(x: 10, y: 3) - sub2(x: 10, y: 3) - blockSub(x: 10, y: 3) - deferSub(x: 10, y: 3) + namedTuple.Item1(namedTuple.Item2) + namedUntypedTuple.Item1(namedUntypedTuple.Item2)
    total += parensNamedTuple.Item1(parensNamedTuple.Item2) + blockNamedTuple.Item1(blockNamedTuple.Item2) + makeNested(2)(3) - gotSwapped(x: 10, y: 3) - getSwapped()(x: 10, y: 3) - getLoopSwapped()(x: 10, y: 3)
    total += -ifSwapped(x: 10, y: 3) + nullableBlockNamedTuple.Item1!!.Item1(nullableBlockNamedTuple.Item2) + genericCtorBox.Callback(4)
    total += ternaryNamed(3) + switchNamed(4) - switchSwapped(x: 10, y: 3)
    total += deferIfNamed(5) + deferCleanupCount + ternaryNil!!(6) + switchNil!!(7)
    total += contravariantVal1(2, "ab") + contravariantVal2(3, "cd") + switchContravariantVal(4, "ef")
    total += makeNamedOrLiteral1(true)(5) + makeNamedOrLiteral2(true)(5) + outerParensNamedTuple.Item1(outerParensNamedTuple.Item2) + assignedNamed(4)
    total += -gotFromDefer(x: 10, y: 3) + mergedOuterTernary(value: 1)(2) + mergedOuterSwitch(value: 1)(3) + gotMergedOuter(value: 1)(4)
    total += deconF(x: 10, y: 3) - deconG(x: 10, y: 3) - swappedTuple.Item2(x: 10, y: 3) - widenedTuple.Item2(x: 10, y: 3) - widenedWithInt64.Item1(x: 10, y: 3) - nestedSwappedTuple.Item1.Item2(x: 10, y: 3) - nestedDeconG(x: 10, y: 3)
    total += opt1(0) + opt2(0) + (if objTuple.Item1 != nil { objTuple.Item2 } else { 0 })
    if strOpt1(0) == "a;0:!clrN=System.String:b|c" && strOpt2(0) == "a|b;0:!clrN=System.String:c" {
        total += 6
    }
    total += useGenericNamedInDelegate(11) + caught
    if fill(out var got) {
        total += got
    }
    return total
}

Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Null(result.UnhandledException)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        // 516 + 5 (assignedNamed(4)) + 3 (caught from nestedThrowOpt()()) + 1 (deferCleanupCount from nestedThrowOpt()) = 525
        Assert.Equal(525, result.Value)

        let refMismatchOnLiteral = EmittedOracle.Evaluate(`var f = (ref value int32) -> value
var x = 1
let _ = f(out x)`)
        let refMismatchDiag = Assert.Single(
            refMismatchOnLiteral.Diagnostics,
            (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error
        )
        Assert.Equal("GS0235", refMismatchDiag.Id)
        Assert.Contains("parameter 'value'", refMismatchDiag.Message, StringComparison.Ordinal)

        let mismatchedRefBranches = EmittedOracle.Evaluate(`let flag = true
let _ = flag ? ((ref s string) -> 1) : ((ref o object) -> 2)`)
        Assert.NotEmpty(mismatchedRefBranches.Diagnostics.Where((d Diagnostic) -> d.IsError))

        let mismatchedSwitchRefBranches = EmittedOracle.Evaluate(`let flag = true
let _ = switch flag {
    case true: (ref s string) -> 1
    default: (ref o object) -> 2
}`)
        Assert.NotEmpty(mismatchedSwitchRefBranches.Diagnostics.Where((d Diagnostic) -> d.IsError))
    }
}
