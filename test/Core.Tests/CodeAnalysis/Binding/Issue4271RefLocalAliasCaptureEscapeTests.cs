// <copyright file="Issue4271RefLocalAliasCaptureEscapeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4271: a closure (lambda or non-generic local function) that
/// captures a <c>ref</c>/<c>var ref</c> LOCAL alias of its enclosing
/// function compiled successfully and silently lost the mutation instead of
/// being rejected — the same failure mode issue #4259 fixed for
/// <c>ref</c>/<c>out</c>/<c>in</c> PARAMETERS (GS9010), but left open for
/// this distinct capture kind (a plain <c>LocalVariableSymbol</c> with
/// <c>RefKind != RefKind.None</c>, not a <c>ParameterSymbol</c> —
/// <see cref="Issue4259RefParameterCaptureEscapeTests"/>'s own
/// <c>RefLocalAlias_CapturedInClosure_DoesNotReport_GS9010</c> test documents
/// the gap directly).
/// <para>
/// Root cause: <c>CaptureBoxingRewriter.IsBoxable</c> refuses to hoist a
/// ref-alias local into a shared box (the managed pointer in its slot would
/// be corrupted by boxing), and nothing else substitutes a correct
/// live-reference capture strategy, so the capture silently falls back to a
/// plain by-value closure-field snapshot — exactly the same silent-mutation-
/// loss bug #4259 fixed for ref parameters, for a different capture kind.
/// </para>
/// <para>
/// Fix: reject the capture outright with the new GS9011, mirroring C#'s own
/// rejection of a ref local captured by a lambda (CS8175) — a closure may
/// outlive the storage the alias points at (an array element, a field, a
/// stack local), so there is no CLR mechanism to keep the managed pointer
/// valid in a heap-allocated closure, and (unlike an ordinary captured
/// local) it cannot be made safe by boxing it either.
/// </para>
/// <para>
/// This is distinct from issue #4222's per-suspension-point liveness check
/// (GS0258): #4222 governs a ref-alias local declared and consumed entirely
/// within one async/iterator suspension segment (never captured by a
/// closure at all); this issue is specifically about capture by a nested
/// closure, a different code path (<c>LambdaBinder</c>'s capture-legality
/// checks, not <c>RefStructAsyncLivenessAnalyzer</c>).
/// </para>
/// These tests bind (but do not lower/emit) source directly via
/// <see cref="GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram"/>, mirroring
/// <see cref="Issue4259RefParameterCaptureEscapeTests"/>.
/// </summary>
public class Issue4271RefLocalAliasCaptureEscapeTests
{
    [Fact]
    public void RefLocalAlias_MutatedInVarBoundLambda_Reports_GS9011()
    {
        // The issue's own repro, verbatim.
        var source = """
            package P
            func Foo() {
                var arr = []int32{1}
                var ref alias = arr[0]
                var f = func() { alias = alias + 1 }
                f()
            }
            """;

        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS9011");
    }

    [Fact]
    public void RefLocalAlias_ReadOnlyCapturedInClosure_Reports_GS9011()
    {
        // A read-only reference (no assignment through the capture) is
        // rejected too, mirroring the GS9010 ref-parameter treatment: even a
        // stale read is unsound once the closure outlives the aliased storage.
        var source = """
            package P
            func Foo() {
                var arr = []int32{1}
                var ref alias = arr[0]
                var f = func() int32 { return alias }
            }
            """;

        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS9011");
    }

    [Fact]
    public void LetRefAlias_CapturedInLetBoundLocalFunction_Reports_GS9011()
    {
        var source = """
            package P
            func Foo() {
                var arr = []int32{1}
                let ref alias = arr[0]
                let Bad = func() int32 {
                    return alias
                }
                Bad()
            }
            """;

        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS9011");
    }

    [Fact]
    public void RefLocalAlias_CapturedInArrowLambda_Reports_GS9011()
    {
        // The `() -> { ... }` arrow spelling binds through BindLambdaExpression,
        // a different call site than the `let name = func ... {...}`
        // local-function spelling — confirm it is covered too.
        var source = """
            package P
            func Foo() {
                var arr = []int32{1}
                var ref alias = arr[0]
                var f = () -> { alias = alias + 1
                    return alias }
            }
            """;

        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS9011");
    }

    [Fact]
    public void RefLocalAlias_CapturedInGenericLocalFunction_Reports_GS9011()
    {
        var source = """
            package P
            func Foo[T](seed T) T {
                var arr = []int32{1}
                var ref alias = arr[0]
                let Bad[U] = func(a U) U {
                    alias = alias + 1
                    return a
                }
                return Bad(seed)
            }
            """;

        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS9011");
    }

    [Fact]
    public void RefLocalAlias_DoesNotReport_GS9010()
    {
        // No cross-contamination: the ref-alias local capture reports its own
        // GS9011, not the ref-parameter GS9010.
        var source = """
            package P
            func Foo() {
                var arr = []int32{1}
                var ref alias = arr[0]
                var f = func() { alias = alias + 1 }
            }
            """;

        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9010");
    }

    [Fact]
    public void RefParameter_CapturedInClosure_StillReports_GS9010_NotGS9011()
    {
        // No regression: issue #4259's own check (a ref/out/in PARAMETER
        // capture) still reports GS9010, unaffected by this fix.
        var source = """
            package P
            func Foo(ref x int32) {
                let Bad = func(a int32) int32 {
                    x = x + 1
                    return a
                }
                Bad(1)
            }
            """;

        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS9010");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9011");
    }

    [Fact]
    public void OrdinaryLocal_CapturedInClosure_IsLegal()
    {
        // No over-rejection: an ordinary (non-ref) captured local — the #523
        // write-through-via-box mechanism — must remain unaffected.
        var source = """
            package P
            func Foo() {
                var total = 0
                var f = func() { total = total + 1 }
                f()
            }
            """;

        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9011");
        Assert.DoesNotContain(diagnostics, d => d.IsError);
    }

    [Fact]
    public void RefLocalAlias_NotCapturedOnlyUsedLocally_IsLegal()
    {
        // Direct, non-closure mutation through the alias in the enclosing
        // function body (never referenced by a nested closure) must remain
        // unaffected — this is the issue's own "control case" that correctly
        // prints 2.
        var source = """
            package P
            func Foo() {
                var arr = []int32{1}
                var ref alias = arr[0]
                alias = alias + 1
            }
            """;

        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9011");
        Assert.DoesNotContain(diagnostics, d => d.IsError);
    }

    [Fact]
    public void RefAlias_ConfinedToOneAsyncSuspensionSegment_NotCapturedByClosure_IsLegal()
    {
        // Issue #4222's legitimate case: a ref-alias local declared and fully
        // consumed inside a single async function, never captured by a NESTED
        // closure — a different code path (RefStructAsyncLivenessAnalyzer /
        // GS0258) from this issue's LambdaBinder capture-legality check. Must
        // remain unaffected by the GS9011 check added here.
        var source = """
            import System.Threading.Tasks

            async func Foo() int32 {
                var arr = []int32{1}
                var ref alias = arr[0]
                alias = 42
                var captured = alias
                await Task.Delay(1)
                return captured
            }
            """;

        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9011");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0258");
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var program = GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(compilation.GlobalScope, compilation.References);
        return tree.Diagnostics
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(program.Diagnostics)
            .ToImmutableArray();
    }
}
