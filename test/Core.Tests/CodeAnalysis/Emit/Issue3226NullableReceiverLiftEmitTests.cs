// <copyright file="Issue3226NullableReceiverLiftEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #3226: a generic extension (or plain generic function) whose
/// parameter is declared <c>T?</c> over an UNCONSTRAINED <c>T</c> encodes the
/// slot as the bare MVAR <c>!!T</c>. A value-type call site therefore pushed a
/// live <c>Nullable&lt;X&gt;</c> into an <c>X</c>-typed slot — invalid IL for
/// primitives (<c>InvalidProgramException</c> at <c>int32?</c>), and a SILENT
/// WRONG VALUE for user structs (the nil <c>Nullable&lt;Point&gt;</c>
/// reinterpreted as a zeroed <c>Point</c>, so the nil receiver dispatched to
/// <c>self!!</c> instead of the fallback). The fix lifts the MethodSpec
/// instantiation to <c>Nullable&lt;X&gt;</c>, wrapping bare-<c>T</c> arguments
/// and unwrapping a bare-<c>T</c> return at the call boundary
/// (<c>MethodBodyEmitter.TryPlanUnconstrainedNullableLift</c>).
/// </summary>
public class Issue3226NullableReceiverLiftEmitTests
{
    private const string OrElseExtension = @"
func (self T?) MyOrElse[T](fb T) T {
    if self != nil { return self!! }
    return fb
}
";

    [Fact]
    public void Int32NullableReceiver_Nil_DispatchesToFallback()
    {
        // Pre-fix: InvalidProgramException (Nullable<int32> pushed into the
        // int32-instantiated !!T slot).
        var result = EmittedOracle.Evaluate(OrElseExtension + @"
var v int32? = nil
v.MyOrElse(99)
");
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(99, result.Value);
    }

    [Fact]
    public void Int32NullableReceiver_Value_DispatchesToSelf()
    {
        // Discriminates against an always-fallback (or always-default)
        // mis-lowering: a non-nil receiver must return its own value through
        // the `self!!` arm and the return unwrap.
        var result = EmittedOracle.Evaluate(OrElseExtension + @"
var v int32? = 5
v.MyOrElse(99)
");
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void UserStructNullableReceiver_Nil_DispatchesToFallback()
    {
        // Pre-fix SILENT WRONG VALUE: ran to completion and returned
        // default(Point).X == 0 — the nil Nullable<Point> receiver was
        // reinterpreted as a zeroed Point, so `self != nil` held.
        var result = EmittedOracle.Evaluate(@"
struct Point {
    var X int32
    var Y int32
}
" + OrElseExtension + @"
var pt Point? = nil
var def = Point{X: 1, Y: 2}
var r = pt.MyOrElse(def)
r.X
");
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void UserStructNullableReceiver_Value_DispatchesToSelf()
    {
        var result = EmittedOracle.Evaluate(@"
struct Point {
    var X int32
    var Y int32
}
" + OrElseExtension + @"
var pt Point? = Point{X: 7, Y: 8}
var def = Point{X: 1, Y: 2}
var r = pt.MyOrElse(def)
r.X
");
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void PlainGenericFunction_TQuestionParameter_ValueTypeInstantiation()
    {
        // The same erased-slot defect reproduced without an extension
        // receiver: the lift keys off the declared T? parameter shape, not
        // extension-ness.
        var result = EmittedOracle.Evaluate(@"
func MyOrElse[T](self T?, fb T) T {
    if self != nil { return self!! }
    return fb
}
var v int32? = nil
MyOrElse(v, 99)
");
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(99, result.Value);
    }

    [Fact]
    public void StringNullableReceiver_Control_StaysOnReferencePath()
    {
        // Reference instantiations keep the historical (working) bare-!!T
        // erasure — no lift, no behavioral change.
        var result = EmittedOracle.Evaluate(OrElseExtension + @"
var s string? = nil
s.MyOrElse(""def"")
");
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal("def", result.Value);
    }
}
