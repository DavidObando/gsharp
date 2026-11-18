// <copyright file="Issue3226NullableReceiverLiftEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System.Linq
import Xunit

/// Nullable receiver APIs require a known kind (ADR-0224).
/// Reference and value controls must preserve nil fallback and present values.
open class Issue3226NullableReceiverLiftEmitTests {
    @Fact
    func Int32NullableReceiver_Nil_DispatchesToFallback() {
        let source = OrElseExtension + `
var v int32? = nil
v.MyOrElse(99)
`
        SourceNullableKindAssertions.Reject(source, "T", 1)
        let result = EmittedOracle.Evaluate(source.Replace("[T]", "[T struct]"))
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(99, result.Value)
    }

    @Fact
    func Int32NullableReceiver_Value_DispatchesToSelf() {
        // Discriminates against an always-fallback (or always-default)
        // mis-lowering: a non-nil receiver must return its own value through
        // the `self!!` arm and the return unwrap.
        let source = OrElseExtension + `
var v int32? = 5
v.MyOrElse(99)
`
        SourceNullableKindAssertions.Reject(source, "T", 1)
        let result = EmittedOracle.Evaluate(source.Replace("[T]", "[T struct]"))
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(5, result.Value)
    }

    @Fact
    func UserStructNullableReceiver_Nil_DispatchesToFallback() {
        // Pre-fix SILENT WRONG VALUE: ran to completion and returned
        // default(Point).X == 0 — the nil Nullable<Point> receiver was
        // reinterpreted as a zeroed Point, so `self != nil` held.
        let source = `
struct Point {
    var X int32
    var Y int32
}
` + OrElseExtension + `
var pt Point? = nil
var def = Point{X: 1, Y: 2}
var r = pt.MyOrElse(def)
r.X
`
        SourceNullableKindAssertions.Reject(source, "T", 1)
        let result = EmittedOracle.Evaluate(source.Replace("[T]", "[T struct]"))
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(1, result.Value)
    }

    @Fact
    func UserStructNullableReceiver_Value_DispatchesToSelf() {
        let source = `
struct Point {
    var X int32
    var Y int32
}
` + OrElseExtension + `
var pt Point? = Point{X: 7, Y: 8}
var def = Point{X: 1, Y: 2}
var r = pt.MyOrElse(def)
r.X
`
        SourceNullableKindAssertions.Reject(source, "T", 1)
        let result = EmittedOracle.Evaluate(source.Replace("[T]", "[T struct]"))
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(7, result.Value)
    }

    @Fact
    func PlainGenericFunction_TQuestionParameter_ValueTypeInstantiation() {
        let source = `
func MyOrElse[T](self T?, fb T) T {
    if self != nil { return self!! }
    return fb
}
var v int32? = nil
MyOrElse(v, 99)
`
        SourceNullableKindAssertions.Reject(source, "T", 1)
        let result = EmittedOracle.Evaluate(source.Replace("[T]", "[T struct]"))
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(99, result.Value)
    }

    @Fact
    func StringNullableReceiver_Control_StaysOnReferencePath() {
        let source = OrElseExtension + `
var s string? = nil
s.MyOrElse("def")
`
        SourceNullableKindAssertions.Reject(source, "T", 1)
        let result = EmittedOracle.Evaluate(source.Replace("[T]", "[T class?]"))
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
