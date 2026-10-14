// <copyright file="Adr0174ChannelAwaitInAsyncFuncEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import System.Collections.Generic
import System.Linq
import System.Reflection
import System.Threading
import Xunit

/// ADR-0174 D4 (Phase 3-1) through real emitted execution: a channel operation
/// inside an `async func` parks the state machine, not a thread. Behavior
/// is unchanged (values, two-value receive, `for … in`, sends), the
/// state machine references the suspending facade and not the blocking one,
/// and — the D4 witness at this phase's scale — more receives can be parked at
/// once than the thread pool has threads.
/// @remarks Discrimination witness (ADR-0154): reverting `ChannelOperationRewriter`
/// (leaving the blocking `ChannelOps.Receive` in async bodies) breaks
/// (cref:ParkedReceives_DoNotHoldThreads): each parked receive then
/// blocks a pool thread, the pool injects threads slowly, and the 512 parked
/// functions do not all complete within the budget. It also breaks
/// (cref:StateMachine_ReferencesTheSuspendingFacade_NotTheBlockingOne).
open class Adr0174ChannelAwaitInAsyncFuncEmitTests {
    @Fact
    func AsyncFunc_ReceivesAndSends_UnchangedBehavior() {
        let result = EmittedOracle.Evaluate(`package P0174AsyncChan
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

run().Result`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(420, result.Value)
    }

    @Fact
    func StateMachine_ReferencesTheSuspendingFacade_NotTheBlockingOne() {
        let result = EmittedOracle.Evaluate(`package P0174AsyncChanIl

async func take(ch chan[int32]) int32 {
    return <-ch
}

let ch = chan[int32](1)
ch <- 5
take(ch).Result`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
        let assembly = Assert.IsAssignableFrom[Assembly](result.Assembly)
        let referenced = ReferencedMethodNames(assembly)
        Assert.Contains("ReceiveValueAsync", referenced)
        Assert.DoesNotContain("Receive", referenced)
    }

    @Fact
    func ParkedReceives_DoNotHoldThreads() {
        let result = EmittedOracle.Evaluate(`package P0174Parked
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
sum`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal(512 * 511 / 2, result.Value)
    }

    @Fact
    func ReceiveInsideLock_KeepsBlocking() {
        let result = EmittedOracle.Evaluate(`package P0174LockRecv

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
take(ch).Result`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(9, result.Value)
    }

    @Fact
    func AsyncLambda_Receives() {
        let result = EmittedOracle.Evaluate(`package P0174AsyncLambdaChan
import System.Threading.Tasks

let ch = chan[int32](1)
ch <- 4
let take = async func() int32 {
    return <-ch
}
take().Result`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(4, result.Value)
    }

    shared {
        private func ReferencedMethodNames(assembly Assembly)[]string {
            // Every MemberRef the emitted module carries, by name; the facade's
            // methods are distinct enough that names suffice.
            let names = List[string]()
            for type in assembly.GetTypes() {
                for method in type.GetMethods(
                    BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly
                ) {
                    let body MethodBody? = method.GetMethodBody()
                    if body == nil {
                        continue
                    }
                    let il[]?uint8 = body.GetILAsByteArray()
                    if il == nil {
                        continue
                    }
                    for var i = 0; i + 4 < il.Length; i++ {
                        if il[i] != uint8(0x28) && il[i] != uint8(0x6F) {
                            continue
                        }
                        let token = BitConverter.ToInt32(il, i + 1)
                        try {
                            let member MethodBase? = method.Module.ResolveMethod(
                                token,
                                if type.IsGenericTypeDefinition {
                                    type.GetGenericArguments()
                                } else {
                                    default([]?Type)
                                },
                                if method.IsGenericMethodDefinition {
                                    method.GetGenericArguments()
                                } else {
                                    default([]?Type)
                                }
                            )
                            if member?.DeclaringType?.FullName == "Gsharp.Concurrency.ChannelOps" {
                                names.Add(member!!.Name)
                            }
                        } catch (ArgumentException) {
                            // Not a method token at this offset; opcode bytes can
                            // coincide with operand bytes.

                        }
                    }
                }
            }
            return names.ToArray()
        }
    }
}
