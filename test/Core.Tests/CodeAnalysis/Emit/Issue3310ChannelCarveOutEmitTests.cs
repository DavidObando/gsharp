// <copyright file="Issue3310ChannelCarveOutEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #3310 / ADR-0159 channel carve-out: <c>chan T</c> is excluded from
/// the empty-instance zero values (an auto-created channel has no sensible
/// default — buffer size and ownership are the decisions <c>make</c>
/// exists to force), and the language has no definite-assignment analysis
/// for ordinary locals nor a nullable-channel spelling, so a bare
/// initializer-less channel declaration is rejected with GS0520 at every
/// declaration surface. On main these declarations compiled and NRE'd on
/// first use.
/// </summary>
public class Issue3310ChannelCarveOutEmitTests
{
    [Fact]
    public void BareChannelLocal_ReportsGS0520()
    {
        var result = EmittedOracle.Evaluate("""
            package P3310ChanLocal

            import Gsharp.Extensions.Go

            func run() int32 {
                var c chan int32
                return 0
            }

            run()
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0520");
    }

    [Fact]
    public void BareChannelGlobal_ReportsGS0520()
    {
        var result = EmittedOracle.Evaluate("""
            package P3310ChanGlobal

            import Gsharp.Extensions.Go

            var c chan int32
            0
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0520");
    }

    [Fact]
    public void BareChannelInstanceField_ReportsGS0520()
    {
        var result = EmittedOracle.Evaluate("""
            package P3310ChanField

            import Gsharp.Extensions.Go

            class Worker {
                var inbox chan int32
            }

            0
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0520");
    }

    [Fact]
    public void BareChannelStaticField_ReportsGS0520()
    {
        var result = EmittedOracle.Evaluate("""
            package P3310ChanStaticField

            import Gsharp.Extensions.Go

            class Bus {
                shared {
                    var events chan int32
                }
            }

            0
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0520");
    }

    [Fact]
    public void InitializedChannelLocal_StaysAccepted()
    {
        // The remedy the diagnostic suggests: explicit `make`.
        var result = EmittedOracle.Evaluate("""
            package P3310ChanMakeLocal

            import Gsharp.Extensions.Go

            func run() int32 {
                var c = make(chan int32, 1)
                c <- 7
                return <-c
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void ChannelFieldWithMakeInitializer_StaysAccepted()
    {
        var result = EmittedOracle.Evaluate("""
            package P3310ChanFieldInit

            import Gsharp.Extensions.Go

            class Worker {
                var inbox chan int32 = make(chan int32, 1)
                func Ping() int32 {
                    inbox <- 5
                    return <-inbox
                }
            }

            func run() int32 {
                var w = Worker()
                return w.Ping()
            }

            run()
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error);
        Assert.Equal(5, result.Value);
    }
}
