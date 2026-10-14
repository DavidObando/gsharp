// <copyright file="Adr0174InferredSuspensionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import System.Collections.Generic
import System.Linq
import System.Reflection
import System.Threading.Tasks
import Xunit

/// ADR-0174 D4 through real emitted execution: a plain `func` pipeline
/// over channels keeps the Go shape in source — no `async`, no
/// `suspend`, no `await` — and compiles to `ValueTask`-returning,
/// `[Suspending]`-labelled state machines wherever a suspension point is
/// reachable, with the entry point staying a plain `void` root.
open class Adr0174InferredSuspensionEmitTests {
    @Fact
    func PlainFuncPipeline_RunsAsWritten() {
        let result = EmittedOracle.Evaluate(`package P0174Inferred

func produce(ch out chan[int32], n int32) {
    for i in 1 ... n + 1 {
        ch <- i
    }
    ch.Close()
}

func square(input in chan[int32], output out chan[int32]) {
    for v in input {
        output <- v * v
    }
    output.Close()
}

func sum(ch in chan[int32]) int32 {
    var total = 0
    for v in ch {
        total = total + v
    }
    return total
}

let a = chan[int32](2)
let b = chan[int32](2)
go produce(a, 4)
go square(a, b)
sum(b)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(30, result.Value)
    }

    @Fact
    func InferredFunctions_AreValueTaskMethods_LabelledSuspending_AndTheEntryPointIsNot() {
        let result = EmittedOracle.Evaluate(`package P0174InferredMeta

func take(ch in chan[int32]) int32 {
    return <-ch
}

func twice(ch in chan[int32]) int32 {
    return take(ch) + take(ch)
}

func plain(x int32) int32 {
    return x * 2
}

let ch = chan[int32](2)
ch <- 1
ch <- 2
plain(twice(ch))`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(6, result.Value)
        let assembly = Assert.IsAssignableFrom[Assembly](result.Assembly)
        Assert.Equal(typeof(ValueTask[int32]), FindMethod(assembly, "take").ReturnType)
        Assert.Equal(typeof(ValueTask[int32]), FindMethod(assembly, "twice").ReturnType)
        Assert.Equal(typeof(int32), FindMethod(assembly, "plain").ReturnType)
        Assert.Contains(
            FindMethod(assembly, "twice").GetCustomAttributesData(),
            (a CustomAttributeData) -> a.AttributeType.FullName == "Gsharp.Concurrency.SuspendingAttribute"
        )
        Assert.DoesNotContain(
            FindMethod(assembly, "plain").GetCustomAttributesData(),
            (a CustomAttributeData) -> a.AttributeType.FullName == "Gsharp.Concurrency.SuspendingAttribute"
        )
    }

    @Fact
    func Lambda_CallingAnInferredFunction_Runs() {
        let result = EmittedOracle.Evaluate(`package P0174InferredLambda

func take(ch in chan[int32]) int32 {
    return <-ch
}

let ch = chan[int32](1)
ch <- 40
let add = (x int32) -> take(ch) + x
add(2)`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ClassMethods_AreInferred_UnlessTheyImplementAnInterface() {
        let result = EmittedOracle.Evaluate(`package P0174InferredMethods

interface Source {
    func Next() int32;
}

class ChanSource : Source {
    var ch chan[int32] = chan[int32](4)
    func Fill() {
        ch <- 3
        ch <- 4
    }
    func Next() int32 {
        return <-ch
    }
}

let s = ChanSource()
s.Fill()
s.Next() + s.Next()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
        let assembly = Assert.IsAssignableFrom[Assembly](result.Assembly)
        let source = assembly.GetTypes().Single((t Type) -> t.Name == "ChanSource")
        Assert.Equal(typeof(ValueTask), source.GetMethod("Fill")!!.ReturnType)
        Assert.Equal(typeof(int32), source.GetMethod("Next")!!.ReturnType)
    }

    @Fact
    func MutualRecursion_OverChannels_Runs() {
        let result = EmittedOracle.Evaluate(`package P0174InferredRecursion

func ping(a chan[int32], b chan[int32], n int32) {
    if n == 0 {
        return
    }
    a <- n
    pong(a, b, n - 1)
}

func pong(a chan[int32], b chan[int32], n int32) {
    let v = <-a
    b <- v
    ping(a, b, n)
}

let a = chan[int32](4)
let b = chan[int32](4)
ping(a, b, 3)
let total = <-b + <-b + <-b
total`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(6, result.Value)
    }

    shared {
        private func FindMethod(assembly Assembly, name string) MethodInfo -> assembly
            .GetTypes()
            .SelectMany(
            func (t Type) IEnumerable[MethodInfo] {
                return t.GetMethods(
                    BindingFlags.Static | BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly
                )
            }
        )
            .Single((m MethodInfo) -> m.Name == name)
    }
}
