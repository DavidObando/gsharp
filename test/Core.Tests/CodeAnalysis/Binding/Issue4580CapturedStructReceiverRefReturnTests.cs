// <copyright file="Issue4580CapturedStructReceiverRefReturnTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4580: a ref-returning function literal declared inside a struct
/// member captures that member's <c>this</c> BY VALUE. A <c>return ref</c>
/// into it would alias the closure's private copy rather than the caller's
/// struct, so writes through the returned reference silently miss the
/// original. When the enclosing member is <c>@UnscopedRef</c> the receiver
/// counts as caller-scoped, which used to let exactly that shape compile;
/// it is now rejected with GS0254 (never GS0589, whose "mark it
/// <c>@UnscopedRef</c>" remedy cannot help a copy).
/// </summary>
public class Issue4580CapturedStructReceiverRefReturnTests
{
    [Theory]
    [InlineData("ref")]
    [InlineData("ref readonly")]
    public void LiteralInUnscopedRefStructMember_ReturningRefIntoCapturedThis_ReportsGS0254(string refKind)
    {
        var result = EmittedOracle.Evaluate($$"""
            import System.Diagnostics.CodeAnalysis

            struct Holder {
                var n int32
                @UnscopedRef
                func Run() int32 {
                    let Slot = func () {{refKind}} int32 {
                        return ref this.n
                    }
                    let v = Slot()
                    return v
                }
            }

            var h = Holder{}
            h.Run()
            """);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0254");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0589");
    }

    /// <summary>
    /// The captured receiver must be function-local on EVERY walk that
    /// reaches it, not only a direct <c>this.n</c>: forwarding it through an
    /// <c>@UnscopedRef</c> member call, through a ref argument of a
    /// ref-returning function, or through a ref local initialised from it.
    /// </summary>
    /// <param name="body">The literal's body.</param>
    [Theory]
    [InlineData("return ref this.Slot()")]
    [InlineData("return ref Forward(ref this.n)")]
    [InlineData("var ref a = this.n\nreturn ref a")]
    public void LiteralInUnscopedRefStructMember_ForwardingCapturedThis_ReportsGS0254(string body)
    {
        var result = EmittedOracle.Evaluate($$"""
            import System.Diagnostics.CodeAnalysis

            func Forward(ref x int32) ref int32 { return ref x }

            struct Holder {
                var n int32
                @UnscopedRef
                func Slot() ref int32 { return ref this.n }
                @UnscopedRef
                func Run() int32 {
                    let S = func () ref int32 {
                        {{body}}
                    }
                    let v = S()
                    return v
                }
            }

            var h = Holder{}
            h.Run()
            """);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0254");
    }

    [Fact]
    public void LiteralInPlainStructMember_ReturningRefIntoCapturedThis_ReportsGS0254NotGS0589()
    {
        var result = EmittedOracle.Evaluate("""
            struct Holder {
                var n int32
                func Run() int32 {
                    let Slot = func () ref int32 {
                        return ref this.n
                    }
                    return Slot()
                }
            }

            var h = Holder{}
            h.Run()
            """);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0254");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0589");
    }

    [Fact]
    public void UnscopedRefStructMember_ReturningRefIntoItsOwnThis_StillAccepted()
    {
        // Control: the member's OWN receiver is not captured, so the
        // ADR-0184 `@UnscopedRef` opt-out keeps working unchanged.
        var result = EmittedOracle.Evaluate("""
            import System.Diagnostics.CodeAnalysis

            struct Holder {
                var n int32
                @UnscopedRef
                func Slot() ref int32 {
                    return ref this.n
                }
            }

            func Run() int32 {
                var h = Holder{}
                h.Slot() = 42
                return h.n
            }

            Run()
            """);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(42, result.Value);
    }
}
