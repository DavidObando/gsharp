// <copyright file="Adr0174ScopeSemanticsEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// ADR-0174 D6 through real emitted execution: the exit-precedence table (a
/// child failure raises <c>ScopeException</c>, a failing body rethrows its own
/// exception unwrapped, both fail with the body at index 0), prompt sibling
/// cancellation through the implicit <c>ctx</c>, nested scopes, and a scope
/// inside a suspending function whose join is awaited rather than blocked.
/// </summary>
/// <remarks>
/// Discrimination witnesses (ADR-0154): a mutant that cancels the frame only
/// at exit breaks <see cref="ChildFailure_CancelsSiblings_Promptly"/> (the
/// sibling runs to its 200-iteration end); a mutant that wraps a lone body
/// exception breaks <see cref="BodyThrows_ChildrenSucceed_RethrowsUnwrapped"/>;
/// a mutant that enters every frame under <c>Context.None</c> instead of the
/// enclosing block's <c>ctx</c> (observed while landing P3-5) breaks
/// <see cref="Ctx_IsAContext_AndNestedScopesLinkIt"/> because <c>ctx.Parent</c>
/// is then the root, not the outer scope's context.
/// </remarks>
public class Adr0174ScopeSemanticsEmitTests
{
    [Fact]
    public void Scope_JoinsGoroutines_BeforeContinuing()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174ScopeJoin
            func send(ch out chan[int32], v int32) {
                ch <- v
            }
            let ch = chan[int32](3)
            scope {
                go send(ch, 1)
                go send(ch, 2)
                go send(ch, 3)
            }
            ch.Length()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void ChildFailure_RaisesScopeException_WithTheCauseFirst()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174ScopeChildFails
            import System
            import Gsharp.Concurrency
            func boom() {
                throw InvalidOperationException("child")
            }
            var caught = ""
            try {
                scope {
                    go boom()
                }
            } catch (e ScopeException) {
                caught = e.FirstFailure.GetType().Name
            }
            caught
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("InvalidOperationException", result.Value);
    }

    [Fact]
    public void BodyThrows_ChildrenSucceed_RethrowsUnwrapped()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174ScopeBodyFails
            import System
            func ok() {
            }
            var caught = ""
            try {
                scope {
                    go ok()
                    throw ArgumentException("body")
                }
            } catch (e Exception) {
                caught = e.GetType().Name
            }
            caught
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("ArgumentException", result.Value);
    }

    [Fact]
    public void ChildFailure_CancelsSiblings_Promptly()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174ScopeCancel
            import System
            import System.Threading
            import Gsharp.Concurrency
            func boom() {
                throw InvalidOperationException("child")
            }
            func slow(ch out chan[int32], ctx Context) {
                var i = 0
                while !ctx.IsCancelled && i < 200 {
                    Thread.Sleep(5)
                    i = i + 1
                }
                ch <- i
            }
            let iterations = chan[int32](1)
            var failed = false
            try {
                scope {
                    go slow(iterations, ctx)
                    go boom()
                }
            } catch (e ScopeException) {
                failed = true
            }
            let ran = <-iterations
            if failed && ran < 200 { 1 } else { 0 }
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void Ctx_IsAContext_AndNestedScopesLinkIt()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174ScopeCtx
            import Gsharp.Concurrency
            var outerCancelledInner = false
            scope {
                let outer = ctx
                scope {
                    outerCancelledInner = ctx.Parent == outer
                }
            }
            if outerCancelledInner { 1 } else { 0 }
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void Scope_InsideASuspendingFunction_JoinsAndReturns()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174ScopeSuspending
            func send(ch out chan[int32], v int32) {
                ch <- v
            }
            func gather() int32 {
                let ch = chan[int32](3)
                scope {
                    go send(ch, 1)
                    go send(ch, 2)
                    go send(ch, 3)
                }
                return <-ch + <-ch + <-ch
            }
            gather()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(6, result.Value);
    }

    [Fact]
    public void ReturnInsideScope_StillJoins()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174ScopeReturn
            func send(ch out chan[int32], v int32) {
                ch <- v
            }
            func early(ch chan[int32]) int32 {
                scope {
                    go send(ch, 7)
                    return 1
                }
                return 0
            }
            let ch = chan[int32](1)
            let r = early(ch)
            r * 10 + ch.Length()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(11, result.Value);
    }
}
