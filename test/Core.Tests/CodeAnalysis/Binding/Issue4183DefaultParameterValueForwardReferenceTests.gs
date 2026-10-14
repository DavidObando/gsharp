// <copyright file="Issue4183DefaultParameterValueForwardReferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #4183: a default-parameter-value expression that forward-references a
/// SIBLING type's static member (e.g. `func M(x int32 = B.Value) int32`, where
/// `B` is declared later in the same compilation) used to give a MISLEADING
/// diagnostic depending purely on unrelated declaration order — GS0158 ("cannot
/// find member") when the referenced type's own body had not yet been bound,
/// versus the semantically-correct GS0265 ("not a compile-time constant") when
/// it had. Neither order ever compiled successfully (the referenced member is a
/// `var`/`const` field read, which `TryExtractConstantDefault` does not
/// fold — a separate, orthogonal gap tracked outside this issue), but which
/// diagnostic you got was purely a function of file order.
///
/// The fix defers default-parameter-value binding (ADR-0063) the same way
/// field/const initializers were already deferred for the identical
/// forward-reference reason (#1070/#1194): a pending-closure queue drained by
/// `DeclarationBinder.BindPendingParameterDefaultValues` once every
/// struct's static-member surface exists compilation-wide, and — per the
/// issue's own ordering constraint — BEFORE `BindPendingBaseInitializers`,
/// since `DeclarationBinder.Constructors.cs` reads
/// `ParameterSymbol.HasExplicitDefaultValue` while resolving a
/// `: base(...)` initializer against a base constructor's optional
/// trailing parameters.
///
/// These tests assert: (1) both declaration orders now report the SAME
/// diagnostic (GS0265, never GS0158) for every default-value call site
/// (instance method, static/shared method, primary constructor is exercised
/// via the class-declaration form, and an explicit `init(...)` constructor);
/// and (2) the base-constructor-initializer ordering constraint itself is not
/// broken — an ordinary optional trailing constructor parameter is still
/// correctly seen as having an explicit default value by the time a derived
/// class's implicit `: base()` call resolves against it.
open class Issue4183DefaultParameterValueForwardReferenceTests {
    @Fact
    func InstanceMethodDefault_SiblingDeclaredAfter_GS0265NotGS0158() {
        // B is declared AFTER C — this used to report GS0158 ("Cannot find
        // member Value") purely because B's shared block hadn't been bound
        // yet when C's default-value expression was bound eagerly.
        const source = "package p\n" +
            "class C {\n" +
            "    func M(x int32 = B.Value) int32 { return x }\n" +
            "}\n" +
            "class B {\n" +
            "    shared { var Value int32 = 42 }\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0265")
    }

    @Fact
    func InstanceMethodDefault_SiblingDeclaredBefore_SameDiagnosticAsAfter() {
        // B is declared BEFORE C — order-independence: must produce the exact
        // same diagnostic as the reversed order above.
        const source = "package p\n" +
            "class B {\n" +
            "    shared { var Value int32 = 42 }\n" +
            "}\n" +
            "class C {\n" +
            "    func M(x int32 = B.Value) int32 { return x }\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0265")
    }

    @Fact
    func ExplicitConstructorDefault_SiblingDeclaredAfter_GS0265NotGS0158() {
        const source = "package p\n" +
            "class C {\n" +
            "    init(x int32 = B.Value) { }\n" +
            "}\n" +
            "class B {\n" +
            "    shared { var Value int32 = 42 }\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0265")
    }

    @Fact
    func ExplicitConstructorDefault_SiblingDeclaredBefore_SameDiagnosticAsAfter() {
        const source = "package p\n" +
            "class B {\n" +
            "    shared { var Value int32 = 42 }\n" +
            "}\n" +
            "class C {\n" +
            "    init(x int32 = B.Value) { }\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0265")
    }

    @Fact
    func StaticMethodDefault_SiblingDeclaredAfter_GS0265NotGS0158() {
        const source = "package p\n" +
            "class C {\n" +
            "    shared { func M(x int32 = B.Value) int32 { return x } }\n" +
            "}\n" +
            "class B {\n" +
            "    shared { var Value int32 = 42 }\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0265")
    }

    @Fact
    func InstanceMethodDefault_SiblingConstField_BothOrders_GS0265NotGS0158() {
        // A `const` field read is ALSO not currently foldable by
        // TryExtractConstantDefault (a separate, orthogonal gap this issue
        // does not fix) — so this still fails, but with the same diagnostic
        // regardless of order, exactly like the `var` case above.
        const classBeforeSibling = "package p\n" +
            "class C {\n" +
            "    func M(x int32 = B.Value) int32 { return x }\n" +
            "}\n" +
            "class B {\n" +
            "    shared { const Value int32 = 42 }\n" +
            "}\n"
        const siblingBeforeClass = "package p\n" +
            "class B {\n" +
            "    shared { const Value int32 = 42 }\n" +
            "}\n" +
            "class C {\n" +
            "    func M(x int32 = B.Value) int32 { return x }\n" +
            "}\n"
        let diagnosticsA = GetDiagnostics(classBeforeSibling)
        let diagnosticsB = GetDiagnostics(siblingBeforeClass)
        Assert.DoesNotContain(diagnosticsA, (d Diagnostic) -> d.Id == "GS0158")
        Assert.DoesNotContain(diagnosticsB, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Contains(diagnosticsA, (d Diagnostic) -> d.Id == "GS0265")
        Assert.Contains(diagnosticsB, (d Diagnostic) -> d.Id == "GS0265")
    }

    @Fact
    func BaseConstructorInitializer_OptionalTrailingParameterDefault_StillResolvesAfterDeferral() {
        // Regression guard for the issue's own ordering constraint:
        // BindPendingParameterDefaultValues MUST drain before
        // BindPendingBaseInitializers, or an ordinary optional trailing
        // constructor parameter (unrelated to any cross-type forward
        // reference — a plain literal default) would appear to NOT have an
        // explicit default value yet when Derived's implicit `: base()` call
        // resolves against Base's constructor, wrongly rejecting the call.
        const source = "package p\n" +
            "open class Base {\n" +
            "    init(x int32 = 5) { }\n" +
            "}\n" +
            "class Derived : Base {\n" +
            "    init() { }\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.Empty(diagnostics)
    }

    @Fact
    func PrimaryConstructorDefault_SiblingDeclaredAfter_GS0265NotGS0158() {
        const source = "package p\n" +
            "class C(x int32 = B.Value) { }\n" +
            "class B {\n" +
            "    shared { var Value int32 = 42 }\n" +
            "}\n"
        let diagnostics = GetDiagnostics(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0158")
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0265")
    }

    shared {
        private func GetDiagnostics(source string) IEnumerable[Diagnostic] {
            let result = EmittedOracle.Evaluate(source)
            return result.Diagnostics.ToList()
        }
    }
}
