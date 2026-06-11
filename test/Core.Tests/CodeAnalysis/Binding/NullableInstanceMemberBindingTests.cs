// <copyright file="NullableInstanceMemberBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #517 — exposes <c>System.Nullable&lt;T&gt;</c>'s instance API
/// (<c>Value</c>, <c>HasValue</c>, <c>GetValueOrDefault</c>) on a
/// value-type <c>T?</c> receiver through the binder, the same way any other
/// CLR struct's instance members are reachable. Verifies the binder no
/// longer reports <c>GS0158</c> for these reads/calls and that NRT
/// (reference-type nullable) receivers continue to surface <c>GS0158</c>
/// because they have no <c>Nullable&lt;T&gt;</c> projection.
/// </summary>
public class NullableInstanceMemberBindingTests
{
    [Fact]
    public void NullableInt32_Value_Binds()
    {
        var source = @"
var a int32? = 7
var v = a.Value
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void NullableInt32_HasValue_Binds()
    {
        var source = @"
var a int32? = 7
var h = a.HasValue
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void NullableBool_Value_Binds()
    {
        var source = @"
var a bool? = true
var v = a.Value
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void NullableBool_HasValue_Binds()
    {
        var source = @"
var a bool? = nil
var h = a.HasValue
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Nullable_GetValueOrDefault_NoArg_Binds()
    {
        var source = @"
var a int32? = nil
var d = a.GetValueOrDefault()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Nullable_GetValueOrDefault_WithFallback_Binds()
    {
        var source = @"
var a int32? = nil
var d = a.GetValueOrDefault(42)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void NullableDateTime_Value_Binds()
    {
        var source = @"
import System

var a DateTime? = DateTime.UtcNow
var v = a.Value
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void NullableDateTime_HasValue_Binds()
    {
        var source = @"
import System

var a DateTime? = nil
var h = a.HasValue
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void NullableInt32_OnParameter_Binds()
    {
        var source = @"
func describe(x int32?) bool {
    return x.HasValue
}

var r = describe(5)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void NullableInt32_OnField_Binds()
    {
        var source = @"
type Holder class {
    var Flag bool?

    init() {
        Flag = nil
    }
}

var h = Holder()
var v = h.Flag.HasValue
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Nullable_StringNrt_HasValue_StillDiagnoses()
    {
        // Per issue #517: NRT reference nullables (`string?`) do NOT
        // project to `System.Nullable<T>` — the binder must keep returning
        // GS0158 for `.HasValue` on a reference-type nullable so users
        // pick the right pattern (`s == nil` / `?.`) rather than a
        // value-type-only API that does not exist on the underlying type.
        var source = @"
var s string? = nil
var h = s.HasValue
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Cannot find member HasValue"));
    }

    [Fact]
    public void Nullable_StringNrt_Value_StillDiagnoses()
    {
        var source = @"
var s string? = nil
var v = s.Value
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Cannot find member Value"));
    }

    [Fact]
    public void Nullable_UnknownMember_StillDiagnoses()
    {
        // `Nullable<T>` doesn't define `Magic`; the binder must still report
        // GS0158 so we don't silently bind to nothing.
        var source = @"
var a int32? = 1
var m = a.Magic
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("Cannot find member Magic"));
    }

    [Fact]
    public void NullableValue_AccessOnNil_ThrowsInvalidOperation()
    {
        // End-to-end through the interpreter: `.Value` on a nil-valued
        // nullable must surface the BCL's `InvalidOperationException`,
        // matching the IL emit path (#504 / #517). The evaluator wraps
        // unhandled BCL throws into a GS9999 diagnostic that carries the
        // original message text.
        var source = @"
var a int32? = nil
var v = a.Value
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS9999" && d.Message.Contains("Nullable"));
    }

    [Fact]
    public void NullableHasValue_OnNil_ReturnsFalse()
    {
        var source = @"
var a int32? = nil
a.HasValue
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(false, result.Value);
    }

    [Fact]
    public void NullableGetValueOrDefault_NoArg_OnNil_ReturnsZero()
    {
        var source = @"
var a int32? = nil
a.GetValueOrDefault()
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void NullableGetValueOrDefault_WithFallback_OnNil_ReturnsFallback()
    {
        var source = @"
var a int32? = nil
a.GetValueOrDefault(99)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(99, result.Value);
    }

    [Fact]
    public void NullableGetValueOrDefault_WithFallback_OnHasValue_ReturnsActual()
    {
        var source = @"
var a int32? = 7
a.GetValueOrDefault(99)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
