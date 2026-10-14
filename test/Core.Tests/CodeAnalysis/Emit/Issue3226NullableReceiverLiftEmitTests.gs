// <copyright file="Issue3226NullableReceiverLiftEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System.Linq
import Xunit

/// Issue #3226: a generic extension (or plain generic function) whose
/// parameter is declared `T?` over an UNCONSTRAINED `T` encodes the
/// slot as the bare MVAR `!!T`. A value-type call site therefore pushed a
/// live `Nullable<X>` into an `X`-typed slot — invalid IL for
/// primitives (`InvalidProgramException` at `int32?`), and a SILENT
/// WRONG VALUE for user structs (the nil `Nullable<Point>`
/// reinterpreted as a zeroed `Point`, so the nil receiver dispatched to
/// `self!!` instead of the fallback). The fix lifts the MethodSpec
/// instantiation to `Nullable<X>`, wrapping bare-`T` arguments
/// and unwrapping a bare-`T` return at the call boundary
/// (`MethodBodyEmitter.TryPlanUnconstrainedNullableLift`).
open class Issue3226NullableReceiverLiftEmitTests {
    @Fact
    func Int32NullableReceiver_Nil_DispatchesToFallback() {
        // Pre-fix: InvalidProgramException (Nullable<int32> pushed into the
        // int32-instantiated !!T slot).
        let result = EmittedOracle.Evaluate(OrElseExtension + `
var v int32? = nil
v.MyOrElse(99)
`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(99, result.Value)
    }

    @Fact
    func Int32NullableReceiver_Value_DispatchesToSelf() {
        // Discriminates against an always-fallback (or always-default)
        // mis-lowering: a non-nil receiver must return its own value through
        // the `self!!` arm and the return unwrap.
        let result = EmittedOracle.Evaluate(OrElseExtension + `
var v int32? = 5
v.MyOrElse(99)
`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(5, result.Value)
    }

    @Fact
    func UserStructNullableReceiver_Nil_DispatchesToFallback() {
        // Pre-fix SILENT WRONG VALUE: ran to completion and returned
        // default(Point).X == 0 — the nil Nullable<Point> receiver was
        // reinterpreted as a zeroed Point, so `self != nil` held.
        let result = EmittedOracle.Evaluate(`
struct Point {
    var X int32
    var Y int32
}
` + OrElseExtension + `
var pt Point? = nil
var def = Point{X: 1, Y: 2}
var r = pt.MyOrElse(def)
r.X
`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(1, result.Value)
    }

    @Fact
    func UserStructNullableReceiver_Value_DispatchesToSelf() {
        let result = EmittedOracle.Evaluate(`
struct Point {
    var X int32
    var Y int32
}
` + OrElseExtension + `
var pt Point? = Point{X: 7, Y: 8}
var def = Point{X: 1, Y: 2}
var r = pt.MyOrElse(def)
r.X
`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(7, result.Value)
    }

    @Fact
    func PlainGenericFunction_TQuestionParameter_ValueTypeInstantiation() {
        // The same erased-slot defect reproduced without an extension
        // receiver: the lift keys off the declared T? parameter shape, not
        // extension-ness.
        let result = EmittedOracle.Evaluate(`
func MyOrElse[T](self T?, fb T) T {
    if self != nil { return self!! }
    return fb
}
var v int32? = nil
MyOrElse(v, 99)
`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(99, result.Value)
    }

    @Fact
    func StringNullableReceiver_Control_StaysOnReferencePath() {
        // Reference instantiations keep the historical (working) bare-!!T
        // erasure — no lift, no behavioral change.
        let result = EmittedOracle.Evaluate(OrElseExtension + `
var s string? = nil
s.MyOrElse("def")
`)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal("def", result.Value)
    }

    shared {
        private const OrElseExtension string = `
func (self T?) MyOrElse[T](fb T) T {
    if self != nil { return self!! }
    return fb
}
`
    }
}
