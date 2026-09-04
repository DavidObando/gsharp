// <copyright file="Adr0174ChannelAwaitInAsyncFuncEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using System.Reflection;
using System.Threading;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// ADR-0174 D4 (Phase 3-1) through real emitted execution: a channel operation
/// inside an <c>async func</c> parks the state machine, not a thread. Behavior
/// is unchanged (values, two-value receive, <c>for … in</c>, sends), the
/// state machine references the suspending facade and not the blocking one,
/// and — the D4 witness at this phase's scale — more receives can be parked at
/// once than the thread pool has threads.
/// </summary>
/// <remarks>
/// Discrimination witness (ADR-0154): reverting <c>ChannelOperationRewriter</c>
/// (leaving the blocking <c>ChannelOps.Receive</c> in async bodies) breaks
/// <see cref="ParkedReceives_DoNotHoldThreads"/>: each parked receive then
/// blocks a pool thread, the pool injects threads slowly, and the 512 parked
/// functions do not all complete within the budget. It also breaks
/// <see cref="StateMachine_ReferencesTheSuspendingFacade_NotTheBlockingOne"/>.
/// </remarks>
public class Adr0174ChannelAwaitInAsyncFuncEmitTests
{
    [Fact]
    public void AsyncFunc_ReceivesAndSends_UnchangedBehavior()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174AsyncChan
            import System.Threading.Tasks

            async func pump(input in chan[int32], output out chan[int32]) int32 {
                var count = 0
                for v in input {
                    output <- v * 2
                    count = count + 1
                }
                output.Close()
                return count
            }

            async func run() int32 {
                let input = chan[int32](4)
                let output = chan[int32](4)
                input <- 1
                input <- 2
                input <- 3
                input.Close()
                let count = await pump(input, output)
                var sum = 0
                while let v = <-output {
                    sum = sum + v
                }
                let (zero, ok) = <-output
                return count * 100 + sum * 10 + (if ok { 1 } else { 0 })
            }

            run().Result
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(420, result.Value);
    }

    [Fact]
    public void StateMachine_ReferencesTheSuspendingFacade_NotTheBlockingOne()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174AsyncChanIl

            async func take(ch chan[int32]) int32 {
                return <-ch
            }

            let ch = chan[int32](1)
            ch <- 5
            take(ch).Result
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
        var assembly = Assert.IsAssignableFrom<Assembly>(result.Assembly);
        var referenced = ReferencedMethodNames(assembly);
        Assert.Contains("ReceiveValueAsync", referenced);
        Assert.DoesNotContain("Receive", referenced);
    }

    [Fact]
    public void ParkedReceives_DoNotHoldThreads()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174Parked
            import System.Collections.Generic
            import System.Threading.Tasks

            async func waitOne(ch chan[int32]) int32 {
                return <-ch
            }

            let ch = chan[int32]()
            let count = 512
            var pending = List[Task[int32]]()
            for i in 0 ... count {
                pending.Add(waitOne(ch))
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
        Assert.Equal(512 * 511 / 2, result.Value);
    }

    [Fact]
    public void ReceiveInsideLock_KeepsBlocking()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174LockRecv

            class Gate {
            }

            async func take(ch chan[int32]) int32 {
                var v = 0
                lock gate {
                    v = <-ch
                }
                return v
            }

            let gate = Gate()
            let ch = chan[int32](1)
            ch <- 9
            take(ch).Result
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(9, result.Value);
    }

    [Fact]
    public void AsyncLambda_Receives()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174AsyncLambdaChan
            import System.Threading.Tasks

            let ch = chan[int32](1)
            ch <- 4
            let take = async func() int32 {
                return <-ch
            }
            take().Result
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(4, result.Value);
    }

    private static string[] ReferencedMethodNames(Assembly assembly)
    {
        // Every MemberRef the emitted module carries, by name; the facade's
        // methods are distinct enough that names suffice.
        var names = new System.Collections.Generic.List<string>();
        foreach (var type in assembly.GetTypes())
        {
            foreach (var method in type.GetMethods(BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
            {
                var body = method.GetMethodBody();
                if (body == null)
                {
                    continue;
                }

                var il = body.GetILAsByteArray();
                if (il == null)
                {
                    continue;
                }

                for (var i = 0; i + 4 < il.Length; i++)
                {
                    if (il[i] != 0x28 && il[i] != 0x6F)
                    {
                        continue;
                    }

                    var token = BitConverter.ToInt32(il, i + 1);
                    try
                    {
                        var member = method.Module.ResolveMethod(token, type.IsGenericTypeDefinition ? type.GetGenericArguments() : null, method.IsGenericMethodDefinition ? method.GetGenericArguments() : null);
                        if (member?.DeclaringType?.FullName == "Gsharp.Concurrency.ChannelOps")
                        {
                            names.Add(member.Name);
                        }
                    }
                    catch (ArgumentException)
                    {
                        // Not a method token at this offset; opcode bytes can
                        // coincide with operand bytes.
                    }
                }
            }
        }

        return names.ToArray();
    }
}
