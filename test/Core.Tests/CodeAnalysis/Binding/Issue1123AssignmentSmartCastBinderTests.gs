// <copyright file="Issue1123AssignmentSmartCastBinderTests.cs" company="GSharp">
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

/// Issue #1123 — Kotlin-style smart cast that narrows a nullable `var`
/// local to its non-nullable underlying type after the local is assigned a
/// statically non-nullable value. Mirrors the existing `if x is T` /
/// nil-guard smart-cast flow analysis, extended to assignment. Covers:
/// positive narrowing (straight-line and into nested blocks), re-narrowing,
/// the invalidation rules (reassigning to a possibly-null value clears the
/// narrowing), and a negative control (no narrowing without the assignment).
open class Issue1123AssignmentSmartCastBinderTests {
    @Fact
    func Assignment_OfNonNullValue_NarrowsNullableLocal() {
        // The minimal repro from the issue.
        let result = Evaluate(`
class E { func M() int32 { return 1 } }
class C {
    func F(fresh E) int32 {
        var x E? = nil
        x = fresh
        return x.M()
    }
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Assignment_Narrowing_ReachesNestedBlock() {
        let result = Evaluate(`
class E { func M() int32 { return 1 } }
class C {
    func F(fresh E) int32 {
        var x E? = nil
        x = fresh
        if true {
            return x.M()
        }
        return 0
    }
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Assignment_Narrowing_ReachesStraightLineStatements() {
        let result = Evaluate(`
class E { func M() int32 { return 1 } }
class C {
    func F(fresh E) int32 {
        var x E? = nil
        x = fresh
        var a = x.M()
        var b = x.M()
        return a + b
    }
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Assignment_Narrowing_ToDerivedAssignedValue() {
        let result = Evaluate(`
open class Base { open func M() int32 { return 1 } }
class Derived : Base { override func M() int32 { return 2 } }
class C {
    func F(d Derived) int32 {
        var x Base? = nil
        x = d
        return x.M()
    }
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func Assignment_ReassignToPossiblyNull_ClearsNarrowing() {
        // Re-assigning `x` to a possibly-null value drops the narrowing, so the
        // subsequent member access fails again.
        let result = Evaluate(`
class E { func M() int32 { return 1 } }
class C {
    func F(fresh E, maybe E?) int32 {
        var x E? = nil
        x = fresh
        x = maybe
        return x.M()
    }
}
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("M", StringComparison.Ordinal))
    }

    @Fact
    func Assignment_ReNarrows_AfterPossiblyNullThenNonNull() {
        // A possibly-null assignment clears the narrowing; a following non-null
        // assignment re-establishes it.
        let result = Evaluate(`
class E { func M() int32 { return 1 } }
class C {
    func F(fresh E, maybe E?) int32 {
        var x E? = nil
        x = maybe
        x = fresh
        return x.M()
    }
}
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func NoAssignment_NegativeControl_DoesNotNarrow() {
        // Without the narrowing assignment, the member access on `E?` fails.
        let result = Evaluate(`
class E { func M() int32 { return 1 } }
class C {
    func F() int32 {
        var x E? = nil
        return x.M()
    }
}
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("M", StringComparison.Ordinal))
    }

    @Fact
    func Assignment_NarrowingDoesNotEscapeBlock_AfterReassign() {
        // After re-assigning `x` to a possibly-null value the narrowing is gone
        // for the rest of the block, including nested blocks.
        let result = Evaluate(`
class E { func M() int32 { return 1 } }
class C {
    func F(fresh E, maybe E?) int32 {
        var x E? = nil
        x = fresh
        x = maybe
        if true {
            return x.M()
        }
        return 0
    }
}
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("M", StringComparison.Ordinal))
    }

    @Fact
    func NullCoalescingAssignment_NarrowsNullableLocal_InStatementAndExpressionPositions() {
        let result = Evaluate(`
import System
open class Base { open func M() int32 -> 10 }
class Derived : Base { override func M() int32 -> 20 }
func F() {
    var x string? = nil
    x ??= "abc"
    Console.WriteLine(x.Length)

    var y string? = nil
    let v = (y ??= "de")
    Console.WriteLine(v.Length + y.Length)

    var z string? = nil
    Console.WriteLine((z ??= "fghi").Length + z.Length)

    var b Base? = nil
    b ??= Derived()
    Console.WriteLine(b.M())

    var ns1 string? = nil
    var ny1 string? = nil
    ns1 ??= (ny1 = "stmt")
    Console.WriteLine(ns1.Length)

    var ns2 string? = nil
    var ny2 string? = nil
    let nestedValue = (ns2 ??= (ny2 = "expr"))
    Console.WriteLine("${nestedValue} ${ns2.Length}")

    var cx string? = nil
    var cy string? = nil
    var cz string? = nil
    let chainValue = (cx ??= (cy ??= (cz = "chain")))
    Console.WriteLine("${chainValue} ${cx.Length}")

    var bx string? = nil
    var bz string? = nil
    var holder = Holder()
    let blockChainValue = (bx ??= (holder.Text ??= (bz = "block")))
    Console.WriteLine("${blockChainValue} ${bx.Length}")

    var ax string? = nil
    var ay string? = nil
    ax = (ay = "both")
    Console.WriteLine("${ax.Length} ${ay.Length}")

    var cField Holder? = nil
    (cField ??= Holder()).Field = 7
    Console.WriteLine(cField.Field)

    var cProp Holder? = nil
    (cProp ??= Holder()).Count = 9
    Console.WriteLine(cProp.Count)

    var cNca Holder? = nil
    let ncaText = ((cNca ??= Holder()).Text ??= "ok")
    Console.WriteLine("${ncaText} ${cNca.Text}")

    let matrix = [2, 2]int32
    var idxText string? = nil
    matrix[0, {
        idxText = "safe"
        0
    }] = 1
    Console.WriteLine(idxText.Length)

    var tx string? = "thrown"
    let _ = (tx ??= throw Exception("missing"))
    Console.WriteLine(tx.Length)

    let maybe string? = nil
    var rx1 string? = nil
    rx1 ??= "safe"
    rx1 ??= maybe
    Console.WriteLine(rx1.Length)

    var rx2 string? = nil
    rx2 ??= "safe"
    let _ = (rx2 ??= maybe)
    Console.WriteLine(rx2.Length)

    var condX string? = nil
    let condV = if (condX ??= "a").Length > 0 { 1 } else { 2 }
    Console.WriteLine("${condV} ${condX.Length}")

    var arrX string? = nil
    let arrValues = []string{(arrX ??= "a")}
    Console.WriteLine("${arrValues.Length} ${arrX.Length}")

    var swX string? = nil
    let swV = switch (swX ??= "a").Length {
        default: 0
    }
    Console.WriteLine("${swV} ${swX.Length}")

    var caX string? = nil
    var caA = 10
    var caB = 20
    let caN = ReadIn(in (caX ??= "safe").Length > 0 ? caA : caB)
    Console.WriteLine("${caN} ${caX.Length}")
}
func ReadIn(in value int32) int32 -> value
class Holder {
    var Field int32
    prop Count int32 { get; set; }
    prop Text string? { get; set; }
}
F()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(
            "3\n4\n8\n20\n4\nexpr 4\nchain 5\nblock 5\n4 4\n7\n9\nok ok\n4\n6\n4\n4\n1 1\n1 1\n0 1\n10 4\n",
            result.Output.ReplaceLineEndings("\n")
        )
    }

    @Fact
    func NullCoalescingAssignment_ClosureCallBeforeExternalCallbackReassignment_InvalidatesNarrowing() {
        let result = Evaluate(`
func F(callback () -> void) int32 {
    var text string? = nil
    var action () -> void = () -> { text = nil }
    let _ = {
        let ignored = (text ??= "safe")
        action()
        action = callback
        0
    }
    return text.Length
}
`)
        let diag = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0158", diag.Id)
    }

    @Fact
    func NullCoalescingAssignment_NullableRhsOrValueType_DoesNotNarrow() {
        let maybeRhs = Evaluate(`
class C {
    func F(maybe string?) int32 {
        var x string? = nil
        x ??= maybe
        return x.Length
    }
}
`)
        Assert.Contains(maybeRhs.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")

        let maybeExpr = Evaluate(`
class C {
    func F(maybe string?) int32 {
        var x string? = nil
        let _ = (x ??= maybe)
        return x.Length
    }
}
`)
        Assert.Contains(maybeExpr.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")

        let valueType = Evaluate(`
func TakesInt(n int32) int32 -> n
class C {
    func F() int32 {
        var n int32? = nil
        n ??= 42
        return TakesInt(n)
    }
}
`)
        Assert.Contains(valueType.Diagnostics, (d Diagnostic) -> d.IsError)

        let gatedHandler = Evaluate(`
import GSharp.Core.Tests.Fixtures
class C {
    func F() int32 {
        var text string? = nil
        let _ = InterpolationHarness.Gated(false, "v=${text ??= "safe"}")
        return text.Length
    }
}
`)
        Assert.Contains(gatedHandler.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
    }

    @Fact
    func NullCoalescingAssignment_ClosureAndGotoInvalidation_ClearsNarrowing() {
        let closureInvalidated = Evaluate(`
class C {
    func F() int32 {
        var x string? = nil
        let reset = () -> { x = nil }
        x ??= "abc"
        reset()
        return x.Length
    }
}
`)
        Assert.Contains(closureInvalidated.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")

        let forwardGotoInvalidated = Evaluate(`
class C {
    func F(skip bool) int32 {
        var x string? = nil
        if skip {
            goto done
        }
        x ??= "abc"
        done:
        return x.Length
    }
}
`)
        Assert.Contains(forwardGotoInvalidated.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")

        let backwardGotoInvalidated = Evaluate(`
class C {
    func F(again bool) int32 {
        var x string? = nil
        x ??= "abc"
        top:
        let n = x.Length
        if again {
            x = nil
            goto top
        }
        return n
    }
}
`)
        Assert.Contains(backwardGotoInvalidated.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
    }

    @Fact
    func Assignment_OfNullCoalescingWithNonNullFallback_NarrowsAndPreservesNarrowing() {
        let positive = Evaluate(`
import System

class NamedType {
    prop TupleUnderlyingType NamedType? { get; init; }
    prop Arity int32 { get; init; }
    prop ConstructedFrom NamedType -> this
}

func Normalize(value object) int32 {
    var named NamedType? = value as NamedType
    if named == nil {
        return 0
    }
    named = named.TupleUnderlyingType ?? named
    return named.Arity + named.ConstructedFrom.Arity
}

func LazyModel(seed NamedType) int32 {
    var model NamedType? = nil
    model = model ?? seed
    var blockModel NamedType? = nil
    blockModel = {
        let first NamedType? = nil
        first ?? seed
    }
    return model.Arity + blockModel.Arity
}

let underlying = NamedType{Arity: 7}
let wrapper = NamedType{TupleUnderlyingType: underlying, Arity: 2}
Console.WriteLine(Normalize(wrapper))
Console.WriteLine(Normalize(underlying))
Console.WriteLine(LazyModel(underlying))
`)
        Assert.Empty(positive.Diagnostics)
        Assert.Equal("14\n14\n14\n", positive.Output.ReplaceLineEndings("\n"))

        let nullableFallback = Evaluate(`
class NamedType {
    prop TupleUnderlyingType NamedType? -> nil
    prop Arity int32 -> 1
}
class C {
    func F(value object, other NamedType?) int32 {
        var named NamedType? = value as NamedType
        if named == nil {
            return 0
        }
        named = named.TupleUnderlyingType ?? other
        return named.Arity
    }
}
`)
        Assert.Contains(nullableFallback.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")

        let explicitNullableCast = Evaluate(`
class NamedType {
    prop TupleUnderlyingType NamedType? -> nil
    prop Arity int32 -> 1
}
class C {
    func F(value object) int32 {
        var named NamedType? = value as NamedType
        if named == nil {
            return 0
        }
        named = cast[NamedType?](named.TupleUnderlyingType ?? named)
        return named.Arity
    }
}
`)
        Assert.Contains(explicitNullableCast.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")

        let explicitNullableCastBlock = Evaluate(`
class NamedType {
    prop TupleUnderlyingType NamedType? -> nil
    prop Arity int32 -> 1
}
class C {
    func F(value object) int32 {
        var named NamedType? = value as NamedType
        if named == nil {
            return 0
        }
        named = cast[NamedType?]({ named.TupleUnderlyingType ?? named })
        return named.Arity
    }
}
`)
        Assert.Contains(explicitNullableCastBlock.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")

        let platformCoalesceFallback = Evaluate(`
@Oblivious
shared class Ob {
    func Nil() string -> nil
}
class C {
    func F() int32 {
        var x string? = nil
        x = nil ?? Ob.Nil()
        return x.Length
    }
}
`)
        Assert.Contains(platformCoalesceFallback.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
