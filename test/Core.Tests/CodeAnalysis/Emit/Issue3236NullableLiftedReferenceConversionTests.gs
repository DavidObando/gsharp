// <copyright file="Issue3236NullableLiftedReferenceConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System.Linq
import Xunit

/// Issue #3236: the emitter could not lower two nullable-lifted REFERENCE
/// conversion shapes the binder accepts (both surfaced as real `gsc`
/// library-build failures by the ADR-0156 Phase 3b.2 oracle-tail migration):
/// - `Service → IService[object?]?` — the covariant user-interface upcast (`#2535`) lifted through
/// reference nullability. `MethodBodyEmitter.IsReferenceCompatible`'s class→interface arm matched
/// implemented interfaces by reference equality only, missing the binder's #2535 declaration-site
/// variance rule, so `EmitConversion` threw
/// `NotSupportedException: Conversion from 'Service' to 'IService[object?]?' is not yet supported`.
/// - `T? → Animal?` under `[T Animal]` — the #2519 constrained-type-parameter box arm only fired for a
/// BARE `T` source and a bare target, so the nullable-lifted form threw
/// `NotSupportedException: Conversion from 'T?' to 'Animal?'`.
/// For reference-type targets `X?` is representation-free (no
/// `Nullable<T>` wrapper), so both lifts degenerate to the
/// underlying reference conversion: a no-op reference load for the variance
/// upcast, and the same `box !!T` the bare #2519 arm emits for the
/// constrained type parameter (null boxes to null, so nil flows through).
open class Issue3236NullableLiftedReferenceConversionTests {
    @Fact
    func RuntimeEquivalentReferenceNullabilityConversion_ExecutesAsIdentity() {
        let result = EmittedOracle.Evaluate(`class Item { prop Value int32 }

func Lift(value Item) Item? -> value

let original = Item{}
original.Value = 42
let lifted = Lift(original)
lifted!!.Value`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Null(result.UnhandledException)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func CovariantInterfaceLift_LibraryShape_EmitsCleanly() {
        // The issue's first repro, on the exact channel that surfaced it:
        // a library compilation (no entry point) through the emitted
        // oracle's IsLibrary option — gsc building this source as a library
        // died with the emit-stage NotSupportedException pre-fix.
        let result = EmittedOracle.Evaluate([]string{`interface IService[out T] {}
class Service : IService[object] {}

func Lift(value Service) IService[object?]? -> value`}, EmittedOracleOptions{IsLibrary: true})
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func CovariantInterfaceLift_FullPinnedFamily_LibraryEmitsCleanly() {
        // The complete #2535 family (the shapes pinned on
        // Compilation.Evaluate by the Phase 3b.2 migration): the direct
        // class lift, the nullable-source lift, the `!!`-asserted
        // non-nullable-target lift, and the smart-cast flow lift must all
        // emit alongside the already-working interface-typed control.
        let result = EmittedOracle.Evaluate([]string{`interface IService[out T] {}
class Service : IService[object] {}

func InterfaceControl(value IService[object]) IService[object?]? -> value
func Lift(value Service) IService[object?]? -> value
func NullableLift(value Service?) IService[object?]? -> value
func AssertedLift(value Service?) IService[object?] -> value!!
func FlowLift(value object?) IService[object?]? {
    if value is Service {
        return value
    }
    return nil
}`}, EmittedOracleOptions{IsLibrary: true})
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func ConstrainedNullableTypeParamToNullableBase_LibraryShape_EmitsCleanly() {
        // The issue's second repro (verbatim), also on the IsLibrary
        // channel: a class-base-constrained T's `T?` converting to the
        // nullable base.
        let result = EmittedOracle.Evaluate([]string{`package p
class Animal { init() {} }
func Sink[T Animal](x T?) Animal? -> x`}, EmittedOracleOptions{IsLibrary: true})
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func CovariantInterfaceLift_Executing_NilFlowsThroughAndNonNilConverts() {
        // End-to-end: a non-nil Service converts (the reference survives the
        // variance lift), and a nil source flows through as nil — the
        // conversion must not fabricate a value in either direction.
        let result = EmittedOracle.Evaluate(`interface IService[out T] {}
class Service : IService[object] {}

func Lift(value Service?) IService[object?]? -> value

let a = Lift(Service{})
let b = Lift(nil)
var r = ""
if a != nil { r = r + "A" }
if b == nil { r = r + "B" }
r`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Null(result.UnhandledException)
        Assert.Equal("AB", result.Value)
    }

    @Fact
    func ConstrainedNullableTypeParam_Executing_NilFlowsThroughAndNonNilConverts() {
        // End-to-end for the `T? → Animal?` shape: `box !!T` on a null
        // reference yields null (nil flows through), and a live Dog boxes to
        // the same reference (a runtime no-op for the class instantiation).
        let result = EmittedOracle.Evaluate(`open class Animal {}
class Dog : Animal {}

func Sink[T Animal](x T?) Animal? -> x

let a = Sink[Dog](Dog{})
let b = Sink[Dog](nil)
var r = ""
if a != nil { r = r + "A" }
if b == nil { r = r + "B" }
r`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Null(result.UnhandledException)
        Assert.Equal("AB", result.Value)
    }

    @Fact
    func UnconstrainedNullableTypeParam_ValueInstantiation_LiftStaysIntact() {
        // Guard for the #3226 unconstrained-`T?` lift (PR #3234): an
        // UNCONSTRAINED T's `T?` slot instantiated at a value type routes
        // through the Nullable<X> MethodSpec lift, which the #3236 arms
        // (keyed on a class-base-constrained T) must leave untouched. A nil
        // Nullable<int32> takes the fallback and a live one unwraps.
        let result = EmittedOracle.Evaluate(`func Pass[T](x T?, fb T) T {
    if x != nil { return x!! }
    return fb
}

var v1 int32? = nil
var v2 int32? = 7
Pass(v1, 99) * 100 + Pass(v2, 0)`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Null(result.UnhandledException)
        Assert.Equal(9907, result.Value)
    }
}
