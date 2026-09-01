// <copyright file="Issue3749NestedTypeConversionCallTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3749 — the conversion-call form <c>T(expr)</c> over a DOTTED type name.
/// <para>
/// The simple-name form (<c>SomeEnum(2)</c>) is bound by
/// <c>OverloadResolver.BindCallExpression</c>, which applies the ADR-0047 §6
/// rule directly: a one-argument call on a non-constructible type IS the
/// explicit conversion. The dotted form parses as an accessor chain and is
/// bound instead by <c>ExpressionBinder.TryBindQualifiedClrConstructorCall</c>,
/// which only ever tried CONSTRUCTORS: it called
/// <c>FinishClrConstructorBindingFailure</c> without the
/// <c>conversionTarget</c> argument that all four sibling call sites supply, so
/// the conversion fallback was unreachable and the call reported
/// <c>GS0159 Cannot find function DebuggingModes</c>.
/// </para>
/// <para>
/// Nesting is what makes the gap visible rather than what causes it — the
/// dotted spelling is the only route a nested type can take, but a
/// namespace-qualified enum takes it too (see
/// <see cref="NamespaceQualifiedEnum_ConversionCall_AlsoBinds"/>, which also
/// fails on <c>main</c>). Adjacent to but distinct from #3660 / PR #3662, which
/// was nested-type bodies calling an enclosing type's <c>shared</c> members; it
/// is NOT a regression of that work.
/// </para>
/// </summary>
public class Issue3749NestedTypeConversionCallTests
{
    /// <summary>The issue's own repro: a nested imported enum, executed.</summary>
    [Fact]
    public void NestedImportedEnum_ConversionCall_Binds()
    {
        var result = EmittedOracle.Evaluate(@"
import System
import System.Diagnostics

let flags = DebuggableAttribute.DebuggingModes(2)
flags.ToString()
");
        Assert.Empty(result.Diagnostics);

        // DebuggingModes.IgnoreSymbolStoreSequencePoints == 2.
        Assert.Equal("IgnoreSymbolStoreSequencePoints", result.Value);
    }

    /// <summary>
    /// The same defect without any nesting: a namespace-qualified enum. Proves
    /// the gap belongs to the DOTTED binding path, not to nested-type
    /// resolution — nested-type resolution (issue #569) already worked.
    /// </summary>
    [Fact]
    public void NamespaceQualifiedEnum_ConversionCall_AlsoBinds()
    {
        var result = EmittedOracle.Evaluate(@"
let d = System.DayOfWeek(2)
d.ToString()
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("Tuesday", result.Value);
    }

    /// <summary>
    /// The differential the fix is really about: the unnested spelling of the
    /// very same conversion already bound on <c>main</c>. Both spellings must
    /// now agree.
    /// </summary>
    [Fact]
    public void UnnestedEnum_ConversionCall_StillBinds()
    {
        var result = EmittedOracle.Evaluate(@"
import System

let d = DayOfWeek(2)
d.ToString()
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("Tuesday", result.Value);
    }

    /// <summary>
    /// Guard rail: the conversion arm is gated on a conversion that actually
    /// exists, so a dotted call over a type with no applicable constructor AND
    /// no conversion from the argument still reports an error rather than
    /// silently binding.
    /// </summary>
    [Fact]
    public void DottedCall_WithNoConversion_StillErrors()
    {
        var result = EmittedOracle.Evaluate(@"
import System
import System.Diagnostics

let flags = DebuggableAttribute.DebuggingModes(""not-a-number"")
flags
");
        Assert.NotEmpty(result.Diagnostics);
    }

    /// <summary>
    /// Anti-regression for the path the fix touches: a dotted CONSTRUCTOR call
    /// must keep resolving as construction, not be hijacked into a conversion.
    /// </summary>
    [Fact]
    public void DottedConstructorCall_StillConstructs()
    {
        var result = EmittedOracle.Evaluate(@"
let sb = System.Text.StringBuilder(16)
sb.Append(""ok"").ToString()
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("ok", result.Value);
    }
}
