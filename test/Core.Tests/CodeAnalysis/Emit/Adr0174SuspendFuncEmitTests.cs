// <copyright file="Adr0174SuspendFuncEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// ADR-0174 D4 through real emitted execution and metadata: a
/// <c>suspend func f() R</c> is a MethodDef returning <c>ValueTask&lt;R&gt;</c>
/// (<c>ValueTask</c> for void) carrying <c>[Gsharp.Concurrency.Suspending]</c>,
/// whose state machine uses the pooling ValueTask builder; G# callers see
/// <c>R</c>, and the whole program behaves as if every call were a plain call.
/// </summary>
/// <remarks>
/// Discrimination witness (ADR-0154): a mutant that leaves the default
/// <c>AsyncValueTaskMethodBuilder</c> in place for suspending functions
/// breaks <see cref="StateMachine_UsesThePoolingBuilder"/>; a mutant that
/// skips the attribute breaks <see cref="MethodDef_ReturnsValueTask_AndIsLabelledSuspending"/>.
/// </remarks>
public class Adr0174SuspendFuncEmitTests
{
    [Fact]
    public void SuspendFuncs_ComposeAndRun()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174Suspend

            suspend func take(ch in chan[int32]) int32 {
                return <-ch
            }

            suspend func sum(ch in chan[int32], n int32) int32 {
                var s = 0
                for i in 0 ... n {
                    s = s + take(ch)
                }
                return s
            }

            suspend func fill(ch out chan[int32], n int32) {
                for i in 1 ... n + 1 {
                    ch <- i
                }
            }

            let ch = chan[int32](8)
            fill(ch, 4)
            sum(ch, 4)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(10, result.Value);
    }

    [Fact]
    public void ExplicitAwait_OnASuspendingCall_RunsLikeTheImplicitOne()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174ExplicitAwait
            suspend func twice(ch in chan[int32]) int32 {
                let v = <-ch
                return v * 2
            }
            suspend func run() int32 {
                let ch = chan[int32](1)
                ch <- 21
                let a = await twice(ch)
                ch <- 5
                let b = twice(ch)
                return a + b
            }
            run()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(52, result.Value);
    }

    [Fact]
    public void BoundaryCaller_BlocksThroughTheBridge_AndWarns()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174SuspendBridge

            suspend func take(ch in chan[int32]) int32 {
                return <-ch
            }

            open class Reader {
                open func Read(ch chan[int32]) int32 {
                    return take(ch) * 10
                }
            }

            let ch = chan[int32](1)
            ch <- 7
            Reader().Read(ch)
            """);

        var warning = Assert.Single(result.Diagnostics);
        Assert.Equal("GS0558", warning.Id);
        Assert.Equal(70, result.Value);
    }

    [Fact]
    public void MethodDef_ReturnsValueTask_AndIsLabelledSuspending()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174SuspendMeta

            suspend func take(ch in chan[int32]) int32 {
                return <-ch
            }

            suspend func fill(ch out chan[int32]) {
                ch <- 5
            }

            let ch = chan[int32](1)
            fill(ch)
            take(ch)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
        var assembly = Assert.IsAssignableFrom<Assembly>(result.Assembly);
        var take = FindMethod(assembly, "take");
        var fill = FindMethod(assembly, "fill");
        Assert.Equal(typeof(ValueTask<int>), take.ReturnType);
        Assert.Equal(typeof(ValueTask), fill.ReturnType);
        Assert.Contains(take.GetCustomAttributesData(), a => a.AttributeType.FullName == "Gsharp.Concurrency.SuspendingAttribute");
        Assert.Contains(fill.GetCustomAttributesData(), a => a.AttributeType.FullName == "Gsharp.Concurrency.SuspendingAttribute");
    }

    [Fact]
    public void StateMachine_UsesThePoolingBuilder()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174SuspendPool

            suspend func take(ch in chan[int32]) int32 {
                return <-ch
            }

            let ch = chan[int32](1)
            ch <- 9
            take(ch)
            """);

        Assert.Empty(result.Diagnostics);
        var assembly = Assert.IsAssignableFrom<Assembly>(result.Assembly);
        var builderFields = assembly.GetTypes()
            .SelectMany(t => t.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
            .Where(f => f.FieldType.Name.Contains("MethodBuilder", StringComparison.Ordinal))
            .ToArray();
        var pooling = Assert.Single(builderFields);
        Assert.Equal("PoolingAsyncValueTaskMethodBuilder`1", pooling.FieldType.Name);
        Assert.Equal(typeof(int), pooling.FieldType.GetGenericArguments()[0]);
    }

    [Fact]
    public void AsyncFuncs_StillUseTheTaskBuilder()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174AsyncStillTask
            import System.Threading.Tasks

            async func compute() int32 {
                await Task.Yield()
                return 3
            }

            compute().Result
            """);

        Assert.Empty(result.Diagnostics);
        var assembly = Assert.IsAssignableFrom<Assembly>(result.Assembly);
        var compute = FindMethod(assembly, "compute");
        Assert.Equal(typeof(Task<int>), compute.ReturnType);
        Assert.DoesNotContain(compute.GetCustomAttributesData(), a => a.AttributeType.FullName == "Gsharp.Concurrency.SuspendingAttribute");
    }

    [Fact]
    public void ParkedSuspendFuncs_DoNotHoldThreads()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174SuspendParked
            import System.Collections.Generic
            import System.Threading.Tasks

            suspend func waitOne(ch chan[int32]) int32 {
                return <-ch
            }

            async func start(ch chan[int32]) int32 {
                return waitOne(ch)
            }

            let ch = chan[int32]()
            let count = 256
            var pending = List[Task[int32]]()
            for i in 0 ... count {
                pending.Add(start(ch))
            }
            for i in 0 ... count {
                ch <- i
            }
            var sum = 0
            for t in pending {
                sum = sum + t.Result
            }
            sum
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal(256 * 255 / 2, result.Value);
    }

    private static MethodInfo FindMethod(Assembly assembly, string name)
        => assembly.GetTypes()
            .SelectMany(t => t.GetMethods(BindingFlags.Static | BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
            .Single(m => m.Name == name);
}
