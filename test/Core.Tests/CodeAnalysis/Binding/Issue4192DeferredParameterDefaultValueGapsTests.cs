// <copyright file="Issue4192DeferredParameterDefaultValueGapsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Three gaps a Copilot review of PR #4192 (issue #4183's deferred
/// default-parameter-value fix) found — each a distinct way the deferred
/// closure in <c>DeclarationBinder.DeferParameterDefaultValueBinding</c>
/// could either run too late or lose too much context relative to the
/// original eager binding it replaced.
/// </summary>
public class Issue4192DeferredParameterDefaultValueGapsTests
{
    /// <summary>
    /// Interfaces and top-level functions still bind their OWN
    /// default-parameter-value expressions eagerly (not deferred). Before
    /// this fix, <c>BindPendingParameterDefaultValues</c> drained AFTER
    /// those eager passes, so a top-level function's own default value that
    /// calls a class method with an optional trailing parameter
    /// (<c>C.F()</c>, where <c>F(x int32 = 1)</c>) saw
    /// <c>ParameterSymbol.HasExplicitDefaultValue == false</c> for that
    /// class parameter during overload resolution, wrongly rejecting the
    /// zero-argument call. Moving the drain before the interfaces/functions
    /// loops (right after <c>DetectClassInheritanceCycles</c>, since every
    /// struct's static-member surface already exists there) fixes this
    /// without narrowing what a class default value could ever legitimately
    /// reach (a class default was never able to call a not-yet-declared
    /// top-level function either before or after #4183).
    /// </summary>
    [Fact]
    public void TopLevelFunctionDefault_CallsConstructorWithOwnPendingDefault_ReachesConstantDiagnosticNotArgCountError()
    {
        // UseIt's OWN default value `C()` omits C's primary-constructor
        // parameter `x`, which itself has a pending default. Before this
        // fix, BindPendingParameterDefaultValues drained AFTER top-level
        // functions bound their own (eager) default expressions, so `x`
        // still reported HasExplicitDefaultValue == false when `C()` was
        // overload-resolved here — wrongly rejecting the zero-argument call
        // with GS0144 ("requires 1 arguments but was given 0") instead of
        // reaching the diagnostic this default value ACTUALLY deserves:
        // GS0265, because a constructor call is never a compile-time
        // constant regardless of the ordering bug. The discriminator is
        // which diagnostic appears, exactly like Issue4183's own GS0158-vs-
        // GS0265 tests: GS0144 signals the ordering bug is back, GS0265
        // signals overload resolution saw the default and correctly moved
        // on to reject the non-constant default value itself.
        const string source =
            "package p\n" +
            "func UseIt(y C = C()) C { return y }\n" +
            "class C(x int32 = 1) {\n" +
            "    var X int32 = x\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0144");
        Assert.Contains(diagnostics, d => d.Id == "GS0265");
    }

    /// <summary>
    /// A generic instance/shared method returning an unconstrained
    /// <c>sequence[T?]</c> is immediately expanded into two specialized
    /// clones (reference-type and value-type <c>T</c>) by
    /// <c>ExpandNullableSequenceIteratorSpecializations</c>, which runs
    /// during the SAME per-struct declaration-body pass that registers the
    /// deferred default-value closure — well before
    /// <c>BindPendingParameterDefaultValues</c> drains it. The original,
    /// unspecialized method symbol (the only one the deferred closure's
    /// captured <c>parameter</c> belongs to) is discarded once
    /// specialization installs its two clones instead, so without a
    /// follow-up copy, an optional parameter on such a method silently lost
    /// its default value entirely on both installed clones. This test
    /// exercises both specializations by calling the method with the
    /// argument omitted against each of a reference-type and a value-type
    /// type argument.
    /// </summary>
    [Fact]
    public void GenericIteratorSpecialization_ArgumentOmitted_UsesDeferredDefaultOnBothClones()
    {
        // The default is a plain literal (not a forward reference) — #4183's
        // deferral applies unconditionally to every parameter default, so a
        // literal default is deferred exactly the same way a forward-
        // referencing one is, and exercises the same specialization-clone
        // gap. (A field-read default like `Config.DefaultLimit` would ALSO
        // hit the orthogonal, pre-existing "default value must be a
        // compile-time constant" restriction #4183 explicitly left alone —
        // unrelated to what this test targets.)
        const string source =
            "package p\n" +
            "class Box {\n" +
            "    func Items[T](limit int32 = 10) sequence[T?] {\n" +
            "        yield break\n" +
            "    }\n" +
            "}\n" +
            "class RefBox {}\n" +
            "func UseRefType(b Box) sequence[RefBox?] { return b.Items[RefBox]() }\n" +
            "func UseValueType(b Box) sequence[int32?] { return b.Items[int32]() }\n";

        var diagnostics = GetDiagnostics(source);

        Assert.Empty(diagnostics);
    }

    /// <summary>
    /// The deferred closure re-establishes scope, package, referencing
    /// syntax tree, and type-parameter context, but originally did NOT
    /// re-establish the <c>unsafe</c> binding context that was active when
    /// the parameter was declared — it runs after the enclosing
    /// <c>unsafe class</c>/<c>unsafe func</c> scope has already unwound. An
    /// explicit pointer-typed default such as <c>default(*int32)</c>
    /// re-binds its type clause against <c>binderCtx.InUnsafeContext</c>, so
    /// without restoring it here the default rebinds as managed by-ref
    /// syntax instead of the raw-pointer type already assigned to the
    /// parameter, and previously valid optional pointer defaults on a
    /// STRUCT/CLASS method (the deferred path — a top-level
    /// <c>unsafe func</c>'s own default still binds eagerly and was never
    /// affected) failed to compile.
    /// </summary>
    [Fact]
    public void UnsafeClassMethodDefault_PointerTyped_BindsAsRawPointerNotManagedByRef()
    {
        const string source =
            "package p\n" +
            "unsafe class Reader {\n" +
            "    func At(cursor *int32 = default(*int32)) *int32 { return cursor }\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.Empty(diagnostics);
    }

    private static IEnumerable<Diagnostic> GetDiagnostics(string source)
    {
        var result = EmittedOracle.Evaluate(source);
        return result.Diagnostics.ToList();
    }
}
