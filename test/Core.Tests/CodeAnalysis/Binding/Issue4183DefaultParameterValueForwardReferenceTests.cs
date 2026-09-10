// <copyright file="Issue4183DefaultParameterValueForwardReferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4183: a default-parameter-value expression that forward-references a
/// SIBLING type's static member (e.g. `func M(x int32 = B.Value) int32`, where
/// `B` is declared later in the same compilation) used to give a MISLEADING
/// diagnostic depending purely on unrelated declaration order — GS0158 ("cannot
/// find member") when the referenced type's own body had not yet been bound,
/// versus the semantically-correct GS0265 ("not a compile-time constant") when
/// it had. Neither order ever compiled successfully (the referenced member is a
/// `var`/`const` field read, which <c>TryExtractConstantDefault</c> does not
/// fold — a separate, orthogonal gap tracked outside this issue), but which
/// diagnostic you got was purely a function of file order.
///
/// The fix defers default-parameter-value binding (ADR-0063) the same way
/// field/const initializers were already deferred for the identical
/// forward-reference reason (#1070/#1194): a pending-closure queue drained by
/// <c>DeclarationBinder.BindPendingParameterDefaultValues</c> once every
/// struct's static-member surface exists compilation-wide, and — per the
/// issue's own ordering constraint — BEFORE <c>BindPendingBaseInitializers</c>,
/// since <c>DeclarationBinder.Constructors.cs</c> reads
/// <c>ParameterSymbol.HasExplicitDefaultValue</c> while resolving a
/// <c>: base(...)</c> initializer against a base constructor's optional
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
/// </summary>
public class Issue4183DefaultParameterValueForwardReferenceTests
{
    [Fact]
    public void InstanceMethodDefault_SiblingDeclaredAfter_GS0265NotGS0158()
    {
        // B is declared AFTER C — this used to report GS0158 ("Cannot find
        // member Value") purely because B's shared block hadn't been bound
        // yet when C's default-value expression was bound eagerly.
        const string source =
            "package p\n" +
            "class C {\n" +
            "    func M(x int32 = B.Value) int32 { return x }\n" +
            "}\n" +
            "class B {\n" +
            "    shared { var Value int32 = 42 }\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0158");
        Assert.Contains(diagnostics, d => d.Id == "GS0265");
    }

    [Fact]
    public void InstanceMethodDefault_SiblingDeclaredBefore_SameDiagnosticAsAfter()
    {
        // B is declared BEFORE C — order-independence: must produce the exact
        // same diagnostic as the reversed order above.
        const string source =
            "package p\n" +
            "class B {\n" +
            "    shared { var Value int32 = 42 }\n" +
            "}\n" +
            "class C {\n" +
            "    func M(x int32 = B.Value) int32 { return x }\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0158");
        Assert.Contains(diagnostics, d => d.Id == "GS0265");
    }

    [Fact]
    public void ExplicitConstructorDefault_SiblingDeclaredAfter_GS0265NotGS0158()
    {
        const string source =
            "package p\n" +
            "class C {\n" +
            "    init(x int32 = B.Value) { }\n" +
            "}\n" +
            "class B {\n" +
            "    shared { var Value int32 = 42 }\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0158");
        Assert.Contains(diagnostics, d => d.Id == "GS0265");
    }

    [Fact]
    public void ExplicitConstructorDefault_SiblingDeclaredBefore_SameDiagnosticAsAfter()
    {
        const string source =
            "package p\n" +
            "class B {\n" +
            "    shared { var Value int32 = 42 }\n" +
            "}\n" +
            "class C {\n" +
            "    init(x int32 = B.Value) { }\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0158");
        Assert.Contains(diagnostics, d => d.Id == "GS0265");
    }

    [Fact]
    public void StaticMethodDefault_SiblingDeclaredAfter_GS0265NotGS0158()
    {
        const string source =
            "package p\n" +
            "class C {\n" +
            "    shared { func M(x int32 = B.Value) int32 { return x } }\n" +
            "}\n" +
            "class B {\n" +
            "    shared { var Value int32 = 42 }\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0158");
        Assert.Contains(diagnostics, d => d.Id == "GS0265");
    }

    [Fact]
    public void InstanceMethodDefault_SiblingConstField_BothOrders_GS0265NotGS0158()
    {
        // A `const` field read is ALSO not currently foldable by
        // TryExtractConstantDefault (a separate, orthogonal gap this issue
        // does not fix) — so this still fails, but with the same diagnostic
        // regardless of order, exactly like the `var` case above.
        const string classBeforeSibling =
            "package p\n" +
            "class C {\n" +
            "    func M(x int32 = B.Value) int32 { return x }\n" +
            "}\n" +
            "class B {\n" +
            "    shared { const Value int32 = 42 }\n" +
            "}\n";
        const string siblingBeforeClass =
            "package p\n" +
            "class B {\n" +
            "    shared { const Value int32 = 42 }\n" +
            "}\n" +
            "class C {\n" +
            "    func M(x int32 = B.Value) int32 { return x }\n" +
            "}\n";

        var diagnosticsA = GetDiagnostics(classBeforeSibling);
        var diagnosticsB = GetDiagnostics(siblingBeforeClass);

        Assert.DoesNotContain(diagnosticsA, d => d.Id == "GS0158");
        Assert.DoesNotContain(diagnosticsB, d => d.Id == "GS0158");
        Assert.Contains(diagnosticsA, d => d.Id == "GS0265");
        Assert.Contains(diagnosticsB, d => d.Id == "GS0265");
    }

    [Fact]
    public void BaseConstructorInitializer_OptionalTrailingParameterDefault_StillResolvesAfterDeferral()
    {
        // Regression guard for the issue's own ordering constraint:
        // BindPendingParameterDefaultValues MUST drain before
        // BindPendingBaseInitializers, or an ordinary optional trailing
        // constructor parameter (unrelated to any cross-type forward
        // reference — a plain literal default) would appear to NOT have an
        // explicit default value yet when Derived's implicit `: base()` call
        // resolves against Base's constructor, wrongly rejecting the call.
        const string source =
            "package p\n" +
            "open class Base {\n" +
            "    init(x int32 = 5) { }\n" +
            "}\n" +
            "class Derived : Base {\n" +
            "    init() { }\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void PrimaryConstructorDefault_SiblingDeclaredAfter_GS0265NotGS0158()
    {
        const string source =
            "package p\n" +
            "class C(x int32 = B.Value) { }\n" +
            "class B {\n" +
            "    shared { var Value int32 = 42 }\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0158");
        Assert.Contains(diagnostics, d => d.Id == "GS0265");
    }

    private static IEnumerable<Diagnostic> GetDiagnostics(string source)
    {
        var result = EmittedOracle.Evaluate(source);
        return result.Diagnostics.ToList();
    }
}
