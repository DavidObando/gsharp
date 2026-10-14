// <copyright file="Issue1627ImportedNullableRefSourceGateTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import Xunit

/// Issue #1627: an imported/CLR-backed nullable reference `S?` was
/// misclassified as implicitly convertible to its non-nullable form `S`
/// because `NullableTypeSymbol` exposes the underlying CLR type, so the
/// generic #521 reference-upcast arm in `Conversion.Classify` saw two
/// ordinary non-value-type CLR types and let the `?` silently drop. The
/// #1552 gate only patched the multi-candidate positional overload filter, so
/// a single-overload call, a named-argument call, an assignment, and a return
/// position all still leaked. This is fixed at the classification source, so
/// every position now reports the same GS0154/GS0155 null-safety diagnostic
/// user-declared classes already got. All allowed nullable-target conversions
/// (`S? -> S?`, `S? -> U?` derived-to-base, and the `!!`
/// escape hatch) must keep compiling. Every type below uses an
/// `Issue1627`-unique name; imported types (`System.Exception` /
/// `System.ArgumentException`) exercise the "live ClrType" leak path that
/// user-declared classes never had.
open class Issue1627ImportedNullableRefSourceGateTests {
    @Fact
    func SingleOverload_ImportedNullableArg_ReportsGS0154() {
        let source = `
package p
import System
func Issue1627ASink(a Exception) int32 -> 1
func Issue1627AUse(e ArgumentException?) int32 -> Issue1627ASink(e)
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0154")
    }

    @Fact
    func NamedArgument_ImportedNullableArg_ReportsGS0154() {
        let source = `
package p
import System
func Issue1627BSink(a Exception) int32 -> 1
func Issue1627BUse(e ArgumentException?) int32 -> Issue1627BSink(a: e)
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0154")
    }

    @Fact
    func Assignment_ImportedNullableSource_ReportsNullSafetyDiagnostic() {
        let source = `
package p
import System
func Issue1627CUse(e ArgumentException?) int32 {
    var x Exception = e
    return 1
}
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Id == "GS0154" || d.Id == "GS0155" || d.Message.Contains("Cannot convert")
        )
    }

    @Fact
    func ReturnPosition_ImportedNullableSource_ReportsNullSafetyDiagnostic() {
        let source = `
package p
import System
func Issue1627DGet(e ArgumentException?) Exception -> e
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Id == "GS0154" || d.Id == "GS0155" || d.Message.Contains("Cannot convert")
        )
    }

    @Fact
    func NullableToNullable_SameType_StillCompiles() {
        let source = `
package p
import System
func Issue1627EGet(e ArgumentException?) Exception? -> e
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func NullableToNullable_DerivedToBase_StillCompiles() {
        let source = `
package p
import System
func Issue1627FSink(a Exception?) int32 -> 1
func Issue1627FUse(e ArgumentException?) int32 -> Issue1627FSink(e)
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Fact
    func BangEscape_ImportedNullableSource_StillCompiles() {
        let source = `
package p
import System
func Issue1627GSink(a Exception) int32 -> 1
func Issue1627GUse(e ArgumentException?) int32 -> Issue1627GSink(e!!)
`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate([]string{source}, EmittedOracleOptions{IsLibrary: true})
        }
    }
}
