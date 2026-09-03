// <copyright file="Adr0174SelectArmsBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0174 D8, the diagnostics guarding the new <c>select</c> arms: a
/// <c>when</c> guard must be a <c>bool</c> (GS0556); <c>case cancelled</c> must
/// have an ambient context to observe or it is silently dead (GS0557); and a
/// select that both sends to and receives from one channel can complete by
/// talking to itself, which is worth saying out loud (GS0564).
/// </summary>
/// <remarks>
/// Discrimination witness (ADR-0154): GS0557 is decided after suspension
/// inference, not at bind time, because whether a function carries a context is
/// only known once the fixed point has run. A mutant that reports it from the
/// binder — "no enclosing <c>scope</c>, therefore no context" — breaks
/// <see cref="CancelledArm_InsideAFunction_NeedsNoScope"/> and
/// <see cref="CancelledArm_WithADeclaredContextParameter_IsAccepted"/>, both of
/// which have a context that arrives through a parameter rather than a block.
/// A mutant that compares bound operands instead of their variable symbols
/// breaks <see cref="SendAndReceiveOnOneChannel_ReportsGS0564"/>, because a
/// receive operand is wrapped in the <c>in chan[T]</c> view conversion and a
/// send operand is not.
/// </remarks>
public class Adr0174SelectArmsBindingTests
{
    [Fact]
    public void NonBooleanGuard_ReportsGS0556()
    {
        var diagnostics = Compile("""
            package P
            let ch = chan[int32](1)
            select {
            case <-ch when 1 { }
            default { }
            }
            """);

        var diagnostic = Assert.Single(diagnostics, d => d.Id == "GS0556");
        Assert.Equal(DiagnosticSeverity.Error, diagnostic.Severity);
        Assert.Contains("'int32'", diagnostic.Message);
    }

    [Fact]
    public void BooleanGuard_IsAccepted()
    {
        var diagnostics = Compile("""
            package P
            let ch = chan[int32](1)
            var ready = true
            select {
            case <-ch when ready { }
            default { }
            }
            """);

        Assert.DoesNotContain(diagnostics, d => d.IsError);
    }

    [Fact]
    public void Guard_CannotSeeTheArmsOwnBinding()
    {
        // The guard decides whether the arm is registered at all, long before a
        // value arrives, so the binding it would introduce is not in scope.
        var diagnostics = Compile("""
            package P
            let ch = chan[int32](1)
            scope {
                select {
                case let v = <-ch when v > 0 { }
                }
            }
            """);

        Assert.Contains(diagnostics, d => d.Id == "GS0125" && d.Message.Contains("'v'"));
    }

    [Fact]
    public void CancelledArm_AtTopLevelWithNoScope_ReportsGS0557()
    {
        var diagnostics = Compile("""
            package P
            let ch = chan[int32](1)
            select {
            case cancelled { }
            case <-ch { }
            }
            """);

        var diagnostic = Assert.Single(diagnostics, d => d.Id == "GS0557");
        Assert.Equal(DiagnosticSeverity.Error, diagnostic.Severity);
    }

    [Fact]
    public void CancelledArm_InsideAScope_IsAccepted()
    {
        var diagnostics = Compile("""
            package P
            let ch = chan[int32](1)
            scope {
                select {
                case cancelled { }
                case <-ch { }
                }
            }
            """);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0557");
    }

    [Fact]
    public void CancelledArm_InsideAFunction_NeedsNoScope()
    {
        // The function is inferred suspending, so it carries the caller's
        // context and the arm is live.
        var diagnostics = Compile("""
            package P
            func wait(ch in chan[int32]) int32 {
                select {
                case cancelled { return -1 }
                case let v = <-ch { return v }
                }
            }
            """);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0557");
    }

    [Fact]
    public void CancelledArm_WithADeclaredContextParameter_IsAccepted()
    {
        // An `open` method is a suspension boundary and never gains a hidden
        // context, but an author who spelled `ctx Context` has said how the
        // context arrives.
        var diagnostics = Compile("""
            package P
            import Gsharp.Concurrency

            open class Reader {
                open func Read(ctx Context, ch in chan[int32]) int32 {
                    select {
                    case cancelled { return -1 }
                    case let v = <-ch { return v }
                    }
                }
            }
            """);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0557");
    }

    [Fact]
    public void CancelledArm_InABoundaryWithoutAContext_ReportsGS0557()
    {
        var diagnostics = Compile("""
            package P
            open class Reader {
                open func Read(ch in chan[int32]) int32 {
                    select {
                    case cancelled { return -1 }
                    case let v = <-ch { return v }
                    }
                }
            }
            """);

        Assert.Single(diagnostics, d => d.Id == "GS0557");
    }

    [Fact]
    public void SendAndReceiveOnOneChannel_ReportsGS0564()
    {
        var diagnostics = Compile("""
            package P
            let ch = chan[int32](1)
            select {
            case ch <- 1 { }
            case <-ch { }
            }
            """);

        var diagnostic = Assert.Single(diagnostics, d => d.Id == "GS0564");
        Assert.Equal(DiagnosticSeverity.Warning, diagnostic.Severity);
        Assert.Contains("'ch'", diagnostic.Message);
    }

    [Fact]
    public void SendAndReceiveOnDifferentChannels_IsSilent()
    {
        var diagnostics = Compile("""
            package P
            let a = chan[int32](1)
            let b = chan[int32](1)
            select {
            case a <- 1 { }
            case <-b { }
            }
            """);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0564");
    }

    [Fact]
    public void TwoReceivesOnOneChannel_IsSilent()
    {
        // Two receive arms on one channel are odd but harmless: the select
        // cannot satisfy itself that way.
        var diagnostics = Compile("""
            package P
            let ch = chan[int32](1)
            select {
            case <-ch { }
            case let v = <-ch { }
            }
            """);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0564");
    }

    [Fact]
    public void AwaitArm_OnANonTask_IsNotAwaitable()
    {
        var diagnostics = Compile("""
            package P
            let ch = chan[int32](1)
            let n = 3
            select {
            case let v = await n { }
            case <-ch { }
            }
            """);

        Assert.Contains(diagnostics, d => d.Id == "GS0133");
    }

    [Fact]
    public void AwaitArm_BindsTheTasksResultType()
    {
        var compilation = new Compilation(SyntaxTree.Parse("""
            package P
            import System.Threading.Tasks
            let ch = chan[int32](1)
            let t = Task.FromResult("hello")
            select {
            case let v = await t { let n = v.Length }
            case <-ch { }
            }
            """));

        Assert.DoesNotContain(EmittedOracle.CompileDiagnostics(compilation), d => d.IsError);
    }

    private static ImmutableArray<Diagnostic> Compile(string source)
        => EmittedOracle.CompileDiagnostics(new Compilation(SyntaxTree.Parse(source)));
}
