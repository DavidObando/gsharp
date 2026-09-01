// <copyright file="Issue3747NullableParamsElementTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3747 — <c>nil</c> in an expanded <c>params</c> position.
/// <para>
/// <c>OverloadResolver.ExpandParamsArguments</c> derived the params ELEMENT
/// type with a bare <c>TypeSymbol.FromClrType(paramArrayType.GetElementType())</c>,
/// which sees only the erased CLR shape. The declaration's <c>[Nullable]</c>
/// metadata was therefore dropped and every <c>params T?[]</c> element bound as
/// non-null <c>T</c>, so <c>nil</c> in an expanded position failed
/// <c>GS0155 Cannot convert type 'nil' to 'object'</c> — note the target prints
/// as <c>object</c>, not <c>object?</c>, which is the annotation loss showing
/// through the diagnostic.
/// </para>
/// <para>
/// The issue as filed believed the defect was specific to a NULLABLE params
/// ARRAY (<c>params object?[]?</c>, as on <c>Delegate.DynamicInvoke</c>), citing
/// <c>string.Format("{0} {1}", "x", nil)</c> as a working control over a
/// non-nullable <c>params object?[]</c>. That control was not a control: two
/// trailing arguments bind the NON-params overload
/// <c>Format(string, object?, object?)</c> and never expand at all.
/// <see cref="PlainNullableElement_ArrayNotNullable_AlsoBinds"/> forces genuine
/// expansion with five arguments and fails on <c>main</c> identically, so the
/// defect was never about the array's own nullability. Both spellings are kept
/// here because they are the two halves of that correction.
/// </para>
/// <para>
/// This is the #3705-family "inconsistent sibling probe" shape but a distinct
/// site from PR #3741's — that PR fixed the signature-position readers in
/// <c>MemberLookup</c>; this is the params-expansion element reader. It is NOT
/// a regression of #3741.
/// </para>
/// </summary>
public class Issue3747NullableParamsElementTests
{
    /// <summary>
    /// The issue's own repro: <c>Delegate.DynamicInvoke(params object?[]? args)</c>.
    /// Executed, not merely bound — the packed array must still emit as
    /// <c>object[]</c> with a null slot, and the invoked delegate returns it.
    /// </summary>
    [Fact]
    public void NullableParamsArray_AcceptsNilElement_AndRoundTrips()
    {
        var result = EmittedOracle.Evaluate(@"
import System

let d Func[object?, object?, object?] = func (a object?, b object?) object? {
    return b
}
let del Delegate = d
del.DynamicInvoke(""x"", nil)
");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.Value);
    }

    /// <summary>
    /// The array itself is NOT nullable here (<c>string.Format(string, params object?[])</c>),
    /// and five arguments force real expansion past every fixed overload. This
    /// is the assertion that disproves the issue's stated isolation.
    /// </summary>
    [Fact]
    public void PlainNullableElement_ArrayNotNullable_AlsoBinds()
    {
        var result = EmittedOracle.Evaluate(@"
import System

string.Format(""{0}|{1}|{2}|{3}|{4}"", ""a"", ""b"", ""c"", ""d"", nil)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("a|b|c|d|", result.Value);
    }

    /// <summary>
    /// The negative control, and the reason the fix reads the declaration rather
    /// than blanket-nullifying every params element: a <c>params string[]</c>
    /// whose element is annotated NON-null must still reject <c>nil</c>. A fix
    /// that simply widened the element type would turn this green and lose the
    /// soundness the annotation buys.
    /// </summary>
    [Fact]
    public void NonNullParamsElement_StillRejectsNil()
    {
        var result = EmittedOracle.Evaluate(@"
import System.IO

Path.Combine(""a"", ""b"", ""c"", nil)
");
        Assert.NotEmpty(result.Diagnostics);
    }

    /// <summary>
    /// Anti-vacuity: an ordinary non-nil element still flows through the
    /// expanded position unchanged, so the fix cannot be passing above merely by
    /// erasing the element type to something that accepts anything.
    /// </summary>
    [Fact]
    public void NonNilElements_StillPackAndFormat()
    {
        var result = EmittedOracle.Evaluate(@"
import System

string.Format(""{0}|{1}|{2}|{3}|{4}"", 1, 2, 3, 4, 5)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("1|2|3|4|5", result.Value);
    }
}
