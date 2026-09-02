// <copyright file="Issue3821QualifiedConstructorOverloadDiagnosticTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3821: a FULLY-QUALIFIED constructor call whose arguments match no
/// constructor reported <c>GS0157 "Cannot find type &lt;first segment&gt;"</c>
/// — a diagnostic about the leading namespace segment, which is perfectly
/// resolvable — instead of the overload error the same call reports when the
/// type name is written unqualified.
/// <para>
/// Cause: <c>TryBindQualifiedClrConstructorCall</c> resolves the dotted name to
/// a CLR type and then asks the shared constructor core to bind. On
/// no-applicable-overload the shared failure helper only commits to
/// <c>GS0267</c> when the call carries an explicit type-argument list (issue
/// #2633 fixed exactly this cascade, but only for the generic spelling), so the
/// non-generic call returned "not handled" and the whole accessor chain
/// re-bound as a namespace walk — which fails at its head and reports GS0157.
/// </para>
/// <para>
/// cs2gs emits fully-qualified type names whenever a simple name is ambiguous
/// (issues #2258 / #3805), so on the self-migration corpus this turns every
/// genuine argument error at such a call site into the same misleading
/// "Cannot find type GSharp" line.
/// </para>
/// </summary>
public sealed class Issue3821QualifiedConstructorOverloadDiagnosticTests
{
    [Fact]
    public void QualifiedConstructorCall_NoApplicableOverload_ReportsOverloadErrorNotMissingType()
    {
        // FAILS on origin/main: reports GS0157 "Cannot find type System".
        const string source = """
            package Demo

            func Build() {
                let sb = System.Text.StringBuilder("a", "b", "c", "d", "e")
            }
            """;

        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, diagnostic => diagnostic.Id == "GS0267");
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Id == "GS0157");
    }

    [Fact]
    public void QualifiedConstructorCall_WrongArgumentType_ReportsOverloadErrorNotMissingType()
    {
        // FAILS on origin/main: reports GS0157 "Cannot find type System".
        // Four arguments matches `StringBuilder(string, int, int, int)` in
        // arity only — the second argument is a string, so no overload applies.
        const string source = """
            package Demo

            func Build() {
                let sb = System.Text.StringBuilder("a", "b", "c", "d")
            }
            """;

        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, diagnostic => diagnostic.Id == "GS0267");
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Id == "GS0157");
    }

    [Fact]
    public void QualifiedConstructorCall_ThatBinds_StillBinds()
    {
        // Anti-vacuity guard rail: PASSES on origin/main and here. The change
        // must only affect the failure path.
        const string source = """
            package Demo

            func Build() string {
                let sb = System.Text.StringBuilder("hi")
                return sb.ToString()
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void QualifiedStaticCall_OnTypeReceiver_StillBinds()
    {
        // Anti-vacuity guard rail: PASSES on origin/main and here. A dotted
        // chain whose last prefix segment is a TYPE (not a namespace) must keep
        // falling through to member binding — the fix is gated on the prefix
        // being a namespace precisely so this shape is untouched.
        const string source = """
            package Demo

            func Combine() string {
                return System.IO.Path.Combine("a", "b")
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void UnqualifiedConstructorCall_NoApplicableOverload_AlreadyReportsOverloadError()
    {
        // Anti-vacuity guard rail: PASSES on origin/main and here. It pins the
        // asymmetry the fix removes — the unqualified spelling of the very same
        // call already reports the overload error.
        const string source = """
            package Demo
            import System.Text

            func Build() {
                let sb = StringBuilder("a", "b", "c", "d", "e")
            }
            """;

        Assert.DoesNotContain(Bind(source), diagnostic => diagnostic.Id == "GS0157");
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        return EmittedOracle.Evaluate(source).Diagnostics;
    }
}
