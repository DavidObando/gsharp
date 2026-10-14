// <copyright file="Issue1629GenericCtorInferenceDoubleBindTests.cs" company="GSharp">
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
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #1629: generic constructor type-argument inference pre-bound every
/// argument to drive inference, then bound the same arguments again for the
/// real call. Because (cref:DiagnosticBag) is append-only, any
/// diagnostic inside an argument (e.g. an undefined variable) was reported
/// twice. The fix rolls back the pre-bind's diagnostics via
/// (cref:DiagnosticBag.TruncateTo) so only the real bind's diagnostics
/// remain. These tests cover both the primary-constructor inference path
/// (`Box(x)`) and the explicit `init(...)` inference path
/// (`Box(x)` where the class declares an explicit constructor), plus a
/// nested-generic-construction case that would previously multiply
/// diagnostics further.
open class Issue1629GenericCtorInferenceDoubleBindTests {
    @Fact
    func PrimaryCtor_GenericInference_UndefinedArgument_ReportsDiagnosticExactlyOnce() {
        let source = `package p
class Box[T](value T) { }
func Use() {
    let b = Box(undefinedVar)
}`
        let diagnostics = Diagnose(source)
        Assert.Single(diagnostics)
    }

    @Fact
    func ExplicitInitCtor_GenericInference_UndefinedArgument_ReportsDiagnosticExactlyOnce() {
        let source = `package p
class Box[T] {
    let value T
    init(v T) { value = v }
}
func Use() {
    let b = Box(undefinedVar)
}`
        let diagnostics = Diagnose(source)
        Assert.Single(diagnostics)
    }

    @Fact
    func PrimaryCtor_NestedGenericInference_UndefinedArgument_ReportsDiagnosticExactlyOnce() {
        // Nested generic construction: without the fix, each level re-binds its
        // own arguments twice, so the innermost undefined-variable diagnostic
        // would multiply with nesting depth.
        let source = `package p
class Box[T](value T) { }
func Use() {
    let b = Box(Box(Box(undefinedVar)))
}`
        let diagnostics = Diagnose(source)
        Assert.Single(diagnostics)
    }

    @Fact
    func PrimaryCtor_GenericInference_ValidArgument_StillCompilesCleanly() {
        let source = `package p
class Box[T](value T) { }
func Use() int32 {
    let b = Box(5)
    return b.value
}`
        let diagnostics = Diagnose(source)
        Assert.Empty(diagnostics)
    }

    @Fact
    func ExplicitInitCtor_GenericInference_ValidArgument_StillCompilesCleanly() {
        let source = `package p
class Box[T] {
    let value T
    init(v T) { value = v }
    func Get() T { return value }
}
func Use() int32 {
    let b = Box(5)
    return b.Get()
}`
        let diagnostics = Diagnose(source)
        Assert.Empty(diagnostics)
    }

    shared {
        private func Diagnose(source string) ImmutableArray[Diagnostic] {
            let result = EmittedOracle.Evaluate(source)
            return result.Diagnostics
        }
    }
}
