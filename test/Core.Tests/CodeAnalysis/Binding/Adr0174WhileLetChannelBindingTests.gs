// <copyright file="Adr0174WhileLetChannelBindingTests.cs" company="GSharp">
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

/// ADR-0174 D3: `while let v = <-ch { … }` loops until the channel is
/// closed. The clause is recognized syntactically (a prefix `<-`
/// initializer) and bypasses ADR-0163's nullable-stripping clause binder, so
/// the binding has the element type exactly and a `nil` element is
/// delivered rather than ending the loop. Clauses gate in source order: a
/// closed channel in the first clause never receives from the second.
/// @remarks Discrimination witnesses (ADR-0154): a mutant that routes the channel
/// clause through `IfLetBindingSupport.BindBindingClause` (stripping the
/// element's nullability and testing the element against `nil`) breaks
/// (cref:NullableElement_NilIsDelivered_NotTreatedAsClosed); a mutant
/// that evaluates every clause before testing any gate breaks
/// (cref:Clauses_ShortCircuit_InSourceOrder), where the second channel
/// would lose its buffered value.
open class Adr0174WhileLetChannelBindingTests {
    @Fact
    func DrainsUntilClosed_ThenExits() {
        let result = EmittedOracle.Evaluate(`package P0174WhileLetDrain
let ch = chan[int32](3)
ch <- 1
ch <- 2
ch <- 3
ch.Close()
var sum = 0
while let v = <-ch {
    sum = sum + v
}
sum`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(6, result.Value)
    }

    @Fact
    func NullableElement_NilIsDelivered_NotTreatedAsClosed() {
        let result = EmittedOracle.Evaluate(`package P0174WhileLetNil
let ch = chan[string?](3)
ch <- "a"
ch <- nil
ch <- "b"
ch.Close()
var seen = 0
var nils = 0
while let s = <-ch {
    seen = seen + 1
    if s == nil {
        nils = nils + 1
    }
}
seen * 10 + nils`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(31, result.Value)
    }

    @Fact
    func Clauses_ShortCircuit_InSourceOrder() {
        let result = EmittedOracle.Evaluate(`package P0174WhileLetShortCircuit
let x = chan[int32](1)
let y = chan[int32](1)
x.Close()
y <- 5
var iterations = 0
while let a = <-x, let b = <-y {
    iterations = iterations + 1
}
iterations * 10 + y.Length()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1, result.Value)
    }

    @Fact
    func ChannelClause_MixesWithNilCheckClause() {
        // ADR-0163 clauses are independent (a later initializer does not see an
        // earlier binding), so the nil-check clause counts its own calls: it
        // yields nil on the third evaluation and ends the loop after two
        // iterations even though the channel still holds a value.
        let result = EmittedOracle.Evaluate(`package P0174WhileLetMixed
var probes = 0
let label = func() string? {
    probes = probes + 1
    if probes == 3 {
        return nil
    }
    return "n"
}
let ch = chan[int32](3)
ch <- 1
ch <- 2
ch <- 3
ch.Close()
var count = 0
while let v = <-ch, let s = label() {
    count = count + s.Length + v
}
count * 10 + ch.Length()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(50, result.Value)
    }

    @Fact
    func ExplicitTypeClause_ConvertsTheElement() {
        let result = EmittedOracle.Evaluate(`package P0174WhileLetTyped
let ch = chan[int32](2)
ch <- 4
ch <- 5
ch.Close()
var total int64 = 0
while let v int64 = <-ch {
    total = total + v
}
total`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(9L, result.Value)
    }

    @Fact
    func BreakAndContinue_Work() {
        let result = EmittedOracle.Evaluate(`package P0174WhileLetJumps
let ch = chan[int32](6)
ch <- 1
ch <- 2
ch <- 3
ch <- 4
ch <- 5
ch <- 6
ch.Close()
var sum = 0
while let v = <-ch {
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
    func InChanParameter_InsideIterator_YieldsEveryElement() {
        let result = EmittedOracle.Evaluate(`package P0174WhileLetIterator
func drain(r in chan[int32]) sequence[int32] {
    while let v = <-r {
        yield v
    }
}
let ch = chan[int32](2)
ch <- 3
ch <- 4
ch.Close()
var sum = 0
for v in drain(ch) {
    sum = sum + v
}
sum`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func Initializer_IsTheChannelItself_ReportsGS0555_NotGS0296() {
        let (diagnostics, _) = Bind(`package P
func main() {
    let ch = chan[int32](1)
    while let v = ch {
    }
}`)
        let diagnostic = Assert.Single(diagnostics)
        Assert.Equal("GS0555", diagnostic.Id)
        Assert.Contains("while let v = <-ch", diagnostic.Message)
    }

    @Fact
    func Initializer_IsANonNullableNonChannel_StillReportsGS0296() {
        let (diagnostics, _) = Bind(`package P
func main() {
    let n = 3
    while let v = n {
    }
}`)
        let diagnostic = Assert.Single(diagnostics)
        Assert.Equal("GS0296", diagnostic.Id)
    }

    @Fact
    func FromSendOnlyHandle_ReportsGS0550() {
        let (diagnostics, _) = Bind(`package P
func f(w out chan[int32]) {
    while let v = <-w {
    }
}`)
        let diagnostic = Assert.Single(diagnostics)
        Assert.Equal("GS0550", diagnostic.Id)
    }

    @Fact
    func Binding_IsReadOnly() {
        let (diagnostics, _) = Bind(`package P
func main() {
    let ch = chan[int32](1)
    while let v = <-ch {
        v = 2
    }
}`)
        Assert.NotEmpty(diagnostics)
        Assert.All(diagnostics, (d Diagnostic) -> Assert.Contains("v", d.Message))
    }

    shared {
        private func Bind(source string)(Diagnostics ImmutableArray[Diagnostic], Compilation Compilation) {
            let compilation = Compilation(SyntaxTree.Parse(source))
            return (EmittedOracle.CompileDiagnostics(compilation), compilation)
        }
    }
}
