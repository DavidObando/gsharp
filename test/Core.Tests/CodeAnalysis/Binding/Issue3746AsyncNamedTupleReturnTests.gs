// <copyright file="Issue3746AsyncNamedTupleReturnTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Tests
import Xunit

/// Issue #3746 (ADR-0172): an `async func` declaring a named-tuple result
/// must keep its element names on the observable `Task[T]` return type.
/// The declared clause `Task[(Output string, Count int32)]` is normalized
/// to the awaited named tuple and re-widened by `LambdaBinder.WrapAsTask`;
/// before the fix that re-widening took the CLR path and closed `Task`1`
/// over the reflected `ValueTuple<string, int>`, erasing the names —
/// so every access on the awaited value reported
/// `GS0158 Cannot find member …`.
/// @remarks Witness of discrimination: the equivalent non-async func returning
/// `Task[(Output string, Count int32)]` always bound (it never goes through
/// `WrapAsTask`), and so did an async func whose named tuple carried a
/// nullable-reference element (that shape already took the symbolic path). The
/// erasure was specific to a fully CLR-backed named tuple behind
/// `async`.
open class Issue3746AsyncNamedTupleReturnTests {
    @Fact
    func AwaitOfAsyncFuncNamedTupleResult_KeepsElementNames() {
        let result = EmittedOracle.Evaluate(`
import System.Threading.Tasks

async func Produce() Task[(Output string, Count int32)] {
    return (Output: "a", Count: 41)
}

async func Consume() Task[string] {
    let t = await Produce()
    return t.Output.PadLeft(t.Count / 41)
}

Consume().Result
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("a", result.Value)
    }

    @Fact
    func ResultOfAsyncFuncNamedTupleResult_KeepsElementNames() {
        let result = EmittedOracle.Evaluate(`
import System.Threading.Tasks

async func Produce() Task[(Output string, Count int32)] {
    return (Output: "a", Count: 41)
}

Produce().Result.Count
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(41, result.Value)
    }

    @Fact
    func ImplicitWrapForm_AsyncFuncNamedTupleResult_KeepsElementNames() {
        // The `async func F() (a, b)` implicit-wrap spelling reaches the same
        // WrapAsTask widening without any Task clause in the source.
        let result = EmittedOracle.Evaluate(`
import System.Threading.Tasks

async func Produce() (Output string, Count int32) {
    return (Output: "a", Count: 7)
}

Produce().Result.Output
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("a", result.Value)
    }

    @Fact
    func ValueTaskWrapper_AsyncFuncNamedTupleResult_KeepsElementNames() {
        let result = EmittedOracle.Evaluate(`
import System.Threading.Tasks

async func Produce() ValueTask[(Output string, Count int32)] {
    return (Output: "v", Count: 3)
}

async func Consume() Task[int32] {
    let t = await Produce()
    return t.Count
}

Consume().Result
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func NestedNamedTupleInsideUnnamedResult_KeepsElementNames() {
        // The names sit one level down, which is why the guard is the
        // structural `ContainsNamedTupleElement` rather than a top-level
        // `TupleTypeSymbol.HasNames` test. (This particular spelling also
        // passed before the fix — the interning cache happened to alias the
        // reconstructed outer tuple onto the literal's named one — so it is a
        // forward-guard, not a failing-on-main witness.)
        let result = EmittedOracle.Evaluate(`
import System.Threading.Tasks

async func Produce() Task[(int32, (Output string, Count int32))] {
    return (1, (Output: "n", Count: 2))
}

async func Consume() Task[string] {
    let t = await Produce()
    return t.Item2.Output
}

Consume().Result
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("n", result.Value)
    }

    @Fact
    func UnnamedTupleResult_StillAwaitsPositionally() {
        let result = EmittedOracle.Evaluate(`
import System.Threading.Tasks

async func Produce() Task[(string, int32)] {
    return ("u", 5)
}

async func Consume() Task[int32] {
    let t = await Produce()
    return t.Item2
}

Consume().Result
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }
}
