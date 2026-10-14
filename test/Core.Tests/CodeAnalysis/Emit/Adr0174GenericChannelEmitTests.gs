// <copyright file="Adr0174GenericChannelEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import Xunit

/// ADR-0174 D2/D9: channels in generic signatures. Writing the library's
/// `merge` — `merge[T](inputs ...chan[T]) in chan[T]` — turned up
/// four gaps that no closed-element program reaches: a directional channel as
/// an array element could not be spelled or tokenized, a variadic whose tail
/// element is a composite mentioning a type parameter was rejected before
/// inference ran, the element could not be inferred through a channel, and the
/// `chan[T]` to `in chan[T]` view call was dropped whenever the
/// element was open.
/// @remarks Discrimination witness (ADR-0154): the dropped view call is the dangerous
/// one — it produced IL that hands a `Channel[T]` to a parameter typed
/// `ChannelReader[T]`, which ILVerify rejects and the JIT turns into a
/// segmentation fault rather than an exception. Restoring the no-op
/// short-circuit for a direction change breaks
/// (cref:DirectionalParameters_TakeABidirectionalArgument_UnderAnOpenElement).
open class Adr0174GenericChannelEmitTests {
    @Fact
    func DirectionalParameters_TakeABidirectionalArgument_UnderAnOpenElement() {
        let result = EmittedOracle.Evaluate(`package P0174GenericChan
func forward[T](input in chan[T], output out chan[T]) {
    for value in input {
        output <- value
    }
}

func run() int32 {
    let source = chan[int32](4)
    let sink = chan[int32](4)
    source <- 1
    source <- 2
    source.Close()
    forward[int32](source, sink)
    sink.Close()

    var total = 0
    for v in sink {
        total = total + v
    }

    return total
}

run()`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func AVariadicOfChannels_InfersItsElement() {
        let result = EmittedOracle.Evaluate(`package P0174VariadicChan
func drain[T](inputs ...chan[T]) int32 {
    var seen = 0
    for input in inputs {
        for value in input {
            seen = seen + 1
        }
    }

    return seen
}

func run() int32 {
    let a = chan[int32](2)
    let b = chan[int32](2)
    a <- 1
    a <- 2
    b <- 3
    a.Close()
    b.Close()
    return drain(a, b)
}

run()`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func AnArrayOfDirectionalChannels_IsSpellableAndEmittable() {
        let result = EmittedOracle.Evaluate(`package P0174ChanArray
func total(readers []in chan[int32]) int32 {
    var sum = 0
    for reader in readers {
        for value in reader {
            sum = sum + value
        }
    }

    return sum
}

func run() int32 {
    let a = chan[int32](2)
    let b = chan[int32](2)
    a <- 4
    b <- 5
    a.Close()
    b.Close()
    return total([]in chan[int32]{ a, b })
}

run()`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal(9, result.Value)
    }

    @Fact
    func AGenericChannelArray_IsTokenizedForAnOpenElement() {
        // The packed form of a `...chan[T]` variadic: an array whose element
        // type mentions the method's type parameter, which has no closed CLR
        // type and so must encode as a type specification.
        let result = EmittedOracle.Evaluate(`package P0174ChanArrayOpen
func count[T](readers []in chan[T]) int32 {
    return readers.Length
}

func run() int32 {
    let a = chan[string](1)
    return count[string]([]in chan[string]{ a, a, a })
}

run()`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.IsError)
        Assert.Equal(3, result.Value)
    }
}
