// <copyright file="Adr0174ChannelMembersEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// ADR-0174 D12: channel members are ordinary members, not built-ins. A
/// constructed channel is a <c>Chan[T]</c> and exposes <c>Length()</c>,
/// <c>Capacity</c>, <c>IsClosed</c> and <c>Dispose</c> (so <c>using let</c>
/// closes it); a <c>chan[T]</c> handle exposes only what
/// <c>Channel&lt;T&gt;</c> has, so <c>Length()</c> on it is the ordinary
/// member-not-found error; <c>Close()</c> binds on a channel or an
/// <c>out chan[T]</c> writer and is not a member of an <c>in chan[T]</c> reader.
/// </summary>
public class Adr0174ChannelMembersEmitTests
{
    [Fact]
    public void Length_OnAChanTHandle_IsAnOrdinaryMemberNotFound()
    {
        var (diagnostics, _) = Bind("""
            package P
            func f(ch chan[int32]) int32 {
                return ch.Length()
            }
            """);

        Assert.NotEmpty(diagnostics);
        Assert.All(diagnostics, d => Assert.Contains("Length", d.Message));
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0566");
    }

    [Fact]
    public void UsingLet_ClosesTheChannel_AtBlockExit()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174UsingLet
            func flag(b bool) int32 {
                if b {
                    return 1
                }
                return 0
            }
            let ch = chan[int32](1)
            var closedInside = false
            {
                using let handle = ch
                closedInside = ch.IsClosed
            }
            flag(closedInside) * 10 + flag(ch.IsClosed)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void Close_OnAnOutHandle_ClosesTheChannel()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174CloseOut
            func stop(w out chan[int32]) {
                w.Close()
            }
            let ch = chan[int32](1)
            stop(ch)
            let (v, ok) = <-ch
            if ok { 1 } else { 0 }
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void Close_OnAnInHandle_IsNotAMember()
    {
        var (diagnostics, _) = Bind("""
            package P
            func stop(r in chan[int32]) {
                r.Close()
            }
            """);

        Assert.NotEmpty(diagnostics);
        Assert.All(diagnostics, d => Assert.Contains("Close", d.Message));
    }

    private static (ImmutableArray<Diagnostic> Diagnostics, Compilation Compilation) Bind(string source)
    {
        var compilation = new Compilation(SyntaxTree.Parse(source));
        return (EmittedOracle.CompileDiagnostics(compilation), compilation);
    }
}
