// <copyright file="Issue3749NestedTypeConversionCallTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Tests
import Xunit

/// Issue #3749 — the conversion-call form `T(expr)` over a DOTTED type name.
///
/// The simple-name form (`SomeEnum(2)`) is bound by
/// `OverloadResolver.BindCallExpression`, which applies the ADR-0047 §6
/// rule directly: a one-argument call on a non-constructible type IS the
/// explicit conversion. The dotted form parses as an accessor chain and is
/// bound instead by `ExpressionBinder.TryBindQualifiedClrConstructorCall`,
/// which only ever tried CONSTRUCTORS: it called
/// `FinishClrConstructorBindingFailure` without the
/// `conversionTarget` argument that all four sibling call sites supply, so
/// the conversion fallback was unreachable and the call reported
/// `GS0159 Cannot find function DebuggingModes`.
///
/// Nesting is what makes the gap visible rather than what causes it — the
/// dotted spelling is the only route a nested type can take, but a
/// namespace-qualified enum takes it too (see
/// (cref:NamespaceQualifiedEnum_ConversionCall_AlsoBinds), which also
/// fails on `main`). Adjacent to but distinct from #3660 / PR #3662, which
/// was nested-type bodies calling an enclosing type's `shared` members; it
/// is NOT a regression of that work.
open class Issue3749NestedTypeConversionCallTests {
    /// The issue's own repro: a nested imported enum, executed.
    @Fact
    func NestedImportedEnum_ConversionCall_Binds() {
        let result = EmittedOracle.Evaluate(`
import System
import System.Diagnostics

let flags = DebuggableAttribute.DebuggingModes(2)
flags.ToString()
`)
        Assert.Empty(result.Diagnostics)
        // DebuggingModes.IgnoreSymbolStoreSequencePoints == 2.
        Assert.Equal("IgnoreSymbolStoreSequencePoints", result.Value)
    }

    /// The same defect without any nesting: a namespace-qualified enum. Proves
    /// the gap belongs to the DOTTED binding path, not to nested-type
    /// resolution — nested-type resolution (issue #569) already worked.
    @Fact
    func NamespaceQualifiedEnum_ConversionCall_AlsoBinds() {
        let result = EmittedOracle.Evaluate(`
let d = System.DayOfWeek(2)
d.ToString()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("Tuesday", result.Value)
    }

    /// The differential the fix is really about: the unnested spelling of the
    /// very same conversion already bound on `main`. Both spellings must
    /// now agree.
    @Fact
    func UnnestedEnum_ConversionCall_StillBinds() {
        let result = EmittedOracle.Evaluate(`
import System

let d = DayOfWeek(2)
d.ToString()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("Tuesday", result.Value)
    }

    /// Guard rail: the conversion arm is gated on a conversion that actually
    /// exists, so a dotted call over a type with no applicable constructor AND
    /// no conversion from the argument still reports an error rather than
    /// silently binding.
    @Fact
    func DottedCall_WithNoConversion_StillErrors() {
        let result = EmittedOracle.Evaluate(`
import System
import System.Diagnostics

let flags = DebuggableAttribute.DebuggingModes("not-a-number")
flags
`)
        Assert.NotEmpty(result.Diagnostics)
    }

    /// Anti-regression for the path the fix touches: a dotted CONSTRUCTOR call
    /// must keep resolving as construction, not be hijacked into a conversion.
    @Fact
    func DottedConstructorCall_StillConstructs() {
        let result = EmittedOracle.Evaluate(`
let sb = System.Text.StringBuilder(16)
sb.Append("ok").ToString()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("ok", result.Value)
    }
}
