// <copyright file="Adr0174ForInChannelBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System.Collections.Immutable
import System.Linq
import Xunit

/// ADR-0174 D3: `for v in ch { … }` drains a channel until it is closed.
/// The channel is decided before the enumerator probe (a channel handle has
/// no `GetEnumerator`), the collection is evaluated once, and the loop
/// takes the `while let` shape around a two-value receive — no new
/// iteration kind, no emitter change. Foreign `Channel<T>` handles
/// take the same path through the runtime's fallback.
/// @remarks Discrimination witness (ADR-0154): a mutant that re-evaluates the
/// collection expression at every check (the `while let` clause's rule)
/// breaks (cref:Collection_IsEvaluatedOnce), which counts the calls of
/// the function producing the channel.
open class Adr0174ForInChannelBindingTests {
    @Fact
    func DrainsUntilClosed_FromAGoroutineProducer() {
        let result = EmittedOracle.Evaluate(`package P0174ForInDrain
func produce(w out chan[int32], n int32) {
    for i in 1 ... n {
        w <- i
    }
    w.Close()
}
let ch = chan[int32](2)
go produce(ch, 5)
var sum = 0
for v in ch {
    sum = sum + v
}
sum`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(10, result.Value)
    }

    @Fact
    func InChanParameter_Drains() {
        let result = EmittedOracle.Evaluate(`package P0174ForInParam
func total(r in chan[int32]) int32 {
    var s = 0
    for v in r {
        s = s + v
    }
    return s
}
let ch = chan[int32](3)
ch <- 1
ch <- 2
ch <- 3
ch.Close()
total(ch)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(6, result.Value)
    }

    @Fact
    func Collection_IsEvaluatedOnce() {
        let result = EmittedOracle.Evaluate(`package P0174ForInOnce
let ch = chan[int32](2)
ch <- 1
ch <- 2
ch.Close()
var calls = 0
let pick = func() chan[int32] {
    calls = calls + 1
    return ch
}
var sum = 0
for v in pick() {
    sum = sum + v
}
calls * 100 + sum`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(103, result.Value)
    }

    @Fact
    func BreakAndContinue_Work() {
        let result = EmittedOracle.Evaluate(`package P0174ForInJumps
let ch = chan[int32](6)
ch <- 1
ch <- 2
ch <- 3
ch <- 4
ch <- 5
ch <- 6
ch.Close()
var sum = 0
for v in ch {
    if v == 2 {
        continue
    }
    if v == 5 {
        break
    }
    sum = sum + v
}
sum * 10 + ch.Length()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(81, result.Value)
    }

    @Fact
    func NullableElement_NilIsDelivered() {
        let result = EmittedOracle.Evaluate(`package P0174ForInNil
let ch = chan[string?](2)
ch <- nil
ch <- "x"
ch.Close()
var seen = 0
var nils = 0
for s in ch {
    seen = seen + 1
    if s == nil {
        nils = nils + 1
    }
}
seen * 10 + nils`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(21, result.Value)
    }

    @Fact
    func TupleElement_DeconstructsPerIteration() {
        let result = EmittedOracle.Evaluate(`package P0174ForInTuple
let ch = chan[(int32, int32)](2)
ch <- (1, 2)
ch <- (3, 4)
ch.Close()
var s = 0
for (a, b) in ch {
    s = s + a * b
}
s`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(14, result.Value)
    }

    @Fact
    func ForeignBclChannel_Drains() {
        let result = EmittedOracle.Evaluate(`package P0174ForInForeign
import System.Threading.Channels
let foreign = Channel.CreateBounded[int32](3)
foreign <- 1
foreign <- 2
foreign <- 3
foreign.Close()
var sum = 0
for v in foreign {
    sum = sum + v
}
sum`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(6, result.Value)
    }

    @Fact
    func ForeignBclReader_Drains() {
        let result = EmittedOracle.Evaluate(`package P0174ForInForeignReader
import System.Threading.Channels
let foreign = Channel.CreateBounded[int32](2)
foreign <- 5
foreign <- 6
foreign.Close()
var sum = 0
for v in foreign.Reader {
    sum = sum + v
}
sum`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(11, result.Value)
    }

    @Fact
    func SendOnlyHandle_ReportsGS0550() {
        let (diagnostics, _) = Bind(`package P
func f(w out chan[int32]) {
    for v in w {
    }
}`)
        let diagnostic = Assert.Single(diagnostics)
        Assert.Equal("GS0550", diagnostic.Id)
    }

    @Fact
    func TwoLoopVariables_ReportGS0554() {
        let (diagnostics, _) = Bind(`package P
func main() {
    let ch = chan[int32](1)
    for k, v in ch {
    }
}`)
        let diagnostic = Assert.Single(diagnostics)
        Assert.Equal("GS0554", diagnostic.Id)
        Assert.Contains("one loop variable", diagnostic.Message)
    }

    shared {
        private func Bind(source string)(Diagnostics ImmutableArray[Diagnostic], Compilation Compilation) {
            let compilation = Compilation(SyntaxTree.Parse(source))
            return (EmittedOracle.CompileDiagnostics(compilation), compilation)
        }
    }
}
