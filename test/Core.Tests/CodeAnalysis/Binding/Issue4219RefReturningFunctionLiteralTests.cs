// <copyright file="Issue4219RefReturningFunctionLiteralTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4219 umbrella remainder, workstream B: a ref-returning FUNCTION
/// LITERAL (<c>func (...) ref T { ... }</c>) — as opposed to #4224's scope,
/// a named ref-returning function/property CALL usable as storage. This is
/// about the literal's OWN declared return kind.
/// <para>
/// Scoped slice actually implemented: a non-generic <c>let name = func (...)
/// ref T { ... }</c> ALWAYS routes through the #4219 direct-call local-
/// function path (<c>StatementBinder.IsRefReturningLocalFunctionDeclaration</c>),
/// standing alone or grouped with another ref-returning sibling, reusing the
/// named-function ref-return machinery in full: <c>FunctionSymbol.ReturnRefKind</c>,
/// the existing <c>return ref</c> statement binder, the #4224 alias/storage
/// machinery for a call result, and the existing escape/lifetime checker
/// (GS0254). Deliberately deferred (see GS0588): converting a ref-returning
/// literal/function to a delegate or function-type VALUE — that needs a
/// return-ref-aware synthesized delegate shape (extending
/// <c>SynthesizedRefDelegateCache</c>, <c>TypeDefEmitter</c>'s Invoke
/// encoding, etc.) that has not been built. A GENERIC ref-returning local
/// function (<c>let f[T] = func (...) ref T {...}</c>) is also deferred for
/// the same reason plus unverified MethodSpec/signature-encoding
/// interaction — GS0588 there too, not a crash.
/// </para>
/// </summary>
public class Issue4219RefReturningFunctionLiteralTests
{
    [Fact]
    public void AliasFromCall_MutatesOriginalArrayElement()
    {
        var result = EmittedOracle.Evaluate("""
            func Run() int32 {
                let at = func(values []int32, index int32) ref int32 {
                    return ref values[index]
                }
                var values = []int32{10}
                var ref alias = at(values, 0)
                alias = 42
                return values[0]
            }
            Run()
            """);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ValueRead_ReadsCurrentValueNotAnAlias()
    {
        var result = EmittedOracle.Evaluate("""
            func Run() int32 {
                let at = func(values []int32, index int32) ref int32 {
                    return ref values[index]
                }
                var values = []int32{10, 20}
                let v = at(values, 1)
                return v
            }
            Run()
            """);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(20, result.Value);
    }

    [Fact]
    public void TwoMemberGroup_ReturnRefForwardingThroughASibling_PreservesIdentity()
    {
        var result = EmittedOracle.Evaluate("""
            func Run() int32 {
                let at = func(values []int32, index int32) ref int32 {
                    return ref values[index]
                }
                let forward = func(values []int32) ref int32 {
                    return ref at(values, 0)
                }
                var values = []int32{10}
                var ref alias = forward(values)
                alias = 99
                return values[0]
            }
            Run()
            """);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(99, result.Value);
    }

    [Fact]
    public void EscapingFunctionLocalStorage_StillReportsGS0254()
    {
        // The existing escape checker is reused as-is; a ref-returning
        // literal gets exactly the same safety coverage a named ref-
        // returning function already has.
        var result = EmittedOracle.Evaluate("""
            func Run() int32 {
                let bad = func() ref int32 {
                    var x = 1
                    return ref x
                }
                return bad()
            }
            Run()
            """);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0254");
    }

    [Fact]
    public void TrailingExpressionBody_ReportsNotAllPathsReturn_NotACrash()
    {
        // Regression pin: #893's implicit-trailing-expression-as-return
        // rewrite (SynthesizeFunctionLiteralTrailingReturn) always
        // synthesizes a VALUE return; applying it to a ref-returning
        // literal produced a ref/value mismatch the emitter could not
        // reconcile (confirmed by direct repro: internal-error crash before
        // this fix). The rewrite is now skipped for a ref-returning
        // literal, so a bare trailing expression (no explicit `return ref`)
        // correctly reports the ordinary not-every-path-returns diagnostic
        // instead of crashing.
        var result = EmittedOracle.Evaluate("""
            func Run() int32 {
                let at = func(xs []int32) ref int32 {
                    xs[0]
                }
                var values = []int32{10}
                return at(values)
            }
            Run()
            """);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0100");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void CapturedOuterVariable_ReturnedByRef_StillReportsGS0254()
    {
        // The existing escape checker treats a captured outer variable the
        // same conservative way it treats a function-local one — this is
        // not new leniency introduced for the literal case.
        var result = EmittedOracle.Evaluate("""
            func Run() int32 {
                var x = 1
                let f = func() ref int32 { return ref x }
                var ref a = f()
                a = 42
                return x
            }
            Run()
            """);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0254");
    }

    [Fact]
    public void ConvertedToExplicitDelegateType_ReportsGS0588_DeferredNotCrashed()
    {
        var result = EmittedOracle.Evaluate("""
            func Run() int32 {
                let at = func(values []int32, index int32) ref int32 { return ref values[index] }
                let cb = at
                return 0
            }
            Run()
            """);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0588");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void PassedAsALambdaArgument_ReportsGS0588_DeferredNotCrashed()
    {
        var result = EmittedOracle.Evaluate("""
            func Accept(f (int32) -> int32) int32 { return f(1) }
            func Run() int32 {
                var x = 1
                return Accept(func(n int32) ref int32 { return ref x })
            }
            Run()
            """);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0588");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }

    [Fact]
    public void VarDeclared_ReportsGS0588_NotSilentlyAccepted()
    {
        // Only a `let` local-function declaration is the direct-call shape;
        // `var` keeps the (unsupported, for ref-return) delegate-cell path.
        var result = EmittedOracle.Evaluate("""
            func Run() int32 {
                var x = 1
                var at = func() ref int32 { return ref x }
                return 0
            }
            Run()
            """);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0588");
    }

    [Fact]
    public void Generic_ReportsGS0588_DeferredNotCrashed()
    {
        var result = EmittedOracle.Evaluate("""
            func Run() int32 {
                let at[T] = func(values []T, index int32) ref T { return ref values[index] }
                return 0
            }
            Run()
            """);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0588");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9999");
    }
}
