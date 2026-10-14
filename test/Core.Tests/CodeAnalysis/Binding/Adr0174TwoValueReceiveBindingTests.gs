// <copyright file="Adr0174TwoValueReceiveBindingTests.cs" company="GSharp">
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

/// ADR-0174 D3: the two-value receive. A prefix `<-ch` in a tuple
/// deconstruction (`let (v, ok) = <-ch`) or a two-target
/// multi-assignment (`v, ok = <-ch`) binds as the `(T, bool)`
/// tuple of `ChannelOps.Receive2<T>`: the element (its zero value
/// once the channel is closed) and whether the channel delivered it. ADR-0168's
/// mixed rule is untouched — `let v, ok = <-ch` declares `v` and
/// assigns an existing `ok` (ADR-0174 errata 9).
/// @remarks Discrimination witness (ADR-0154): a mutant that binds the deconstruction
/// initializer through the single-value receive (element-typed, not a tuple)
/// breaks every fact here with a deconstruction-arity diagnostic; a mutant
/// that drops the `ok` flag on close breaks
/// (cref:NullableElement_NilWithOkTrue_IsDistinguishableFromClosed),
/// where a delivered `nil` and a closed channel produce the same element
/// and differ only in the flag.
open class Adr0174TwoValueReceiveBindingTests {
    @Fact
    func TupleDeconstruction_DeliveredThenClosed_ReportsOkThenNotOk() {
        let result = EmittedOracle.Evaluate((`package P0174TwoValue
` + "$Flag" + `
let ch = chan[int32](1)
ch <- 9
let (v1, ok1) = <-ch
ch.Close()
let (v2, ok2) = <-ch
flag(ok1) * 1000 + v1 * 10 + flag(ok2) * 100 + v2`))
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1090, result.Value)
    }

    @Fact
    func VarDeconstruction_BindsMutableNames() {
        let result = EmittedOracle.Evaluate((`package P0174TwoValueVar
` + "$Flag" + `
let ch = chan[int32](1)
ch <- 4
var (v, ok) = <-ch
v = v + 1
ok = !ok
v * 10 + flag(ok)`))
        Assert.Empty(result.Diagnostics)
        Assert.Equal(50, result.Value)
    }

    @Fact
    func MultiTarget_AssignsExistingVariables() {
        let result = EmittedOracle.Evaluate((`package P0174TwoValueAssign
` + "$Flag" + `
let ch = chan[int32](1)
ch <- 5
var v = 0
var ok = false
v, ok = <-ch
v * 10 + flag(ok)`))
        Assert.Empty(result.Diagnostics)
        Assert.Equal(51, result.Value)
    }

    @Fact
    func MixedLetTarget_DeclaresFirst_AssignsExistingSecond() {
        // ADR-0168's rule survives: `let v, ok = <-ch` declares only `v`.
        let result = EmittedOracle.Evaluate((`package P0174TwoValueMixed
` + "$Flag" + `
let ch = chan[int32](1)
ch <- 7
var ok = false
let v, ok = <-ch
v * 10 + flag(ok)`))
        Assert.Empty(result.Diagnostics)
        Assert.Equal(71, result.Value)
    }

    @Fact
    func MixedLetTarget_WithUndeclaredSecond_IsTheOrdinaryUndefinedVariable() {
        let (diagnostics, _) = Bind(`package P
func main() {
    let ch = chan[int32](1)
    let v, ok = <-ch
}`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0125" && d.Message.Contains("'ok'"))
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0554")
    }

    @Fact
    func ThreeNames_InDeconstruction_ReportGS0554() {
        let (diagnostics, _) = Bind(`package P
func main() {
    let ch = chan[int32](1)
    let (a, b, c) = <-ch
}`)
        let diagnostic = Assert.Single(diagnostics)
        Assert.Equal("GS0554", diagnostic.Id)
        Assert.Contains("two names", diagnostic.Message)
        Assert.Contains("not 3", diagnostic.Message)
    }

    @Fact
    func ThreeTargets_InMultiAssignment_ReportGS0554() {
        let (diagnostics, _) = Bind(`package P
func main() {
    let ch = chan[int32](1)
    var a = 0
    var b = false
    var c = 0
    a, b, c = <-ch
}`)
        let diagnostic = Assert.Single(diagnostics)
        Assert.Equal("GS0554", diagnostic.Id)
        Assert.Contains("two targets", diagnostic.Message)
    }

    @Fact
    func FromSendOnlyHandle_ReportsGS0550() {
        let (diagnostics, _) = Bind(`package P
func f(w out chan[int32]) {
    let (v, ok) = <-w
}`)
        let diagnostic = Assert.Single(diagnostics)
        Assert.Equal("GS0550", diagnostic.Id)
    }

    @Fact
    func FromNonChannel_ReportsGS0139() {
        let (diagnostics, _) = Bind(`package P
func main() {
    let n = 3
    let (v, ok) = <-n
}`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0139")
    }

    @Fact
    func InChanParameter_Receives() {
        let result = EmittedOracle.Evaluate((`package P0174TwoValueIn
` + "$Flag" + `
func take(r in chan[int32]) int32 {
    let (v, ok) = <-r
    return v * 10 + flag(ok)
}
let ch = chan[int32](1)
ch <- 3
take(ch)`))
        Assert.Empty(result.Diagnostics)
        Assert.Equal(31, result.Value)
    }

    @Fact
    func NullableElement_NilWithOkTrue_IsDistinguishableFromClosed() {
        let result = EmittedOracle.Evaluate((`package P0174TwoValueNil
` + "$Flag" + `
let ch = chan[string?](2)
ch <- nil
ch.Close()
let (first, okFirst) = <-ch
let (second, okSecond) = <-ch
flag(first == nil) * 1000 + flag(okFirst) * 100 + flag(second == nil) * 10 + flag(okSecond)`))
        Assert.Empty(result.Diagnostics)
        Assert.Equal(1110, result.Value)
    }

    @Fact
    func ForeignBclChannel_TakesTheFallback() {
        let result = EmittedOracle.Evaluate((`package P0174TwoValueForeign
import System.Threading.Channels
` + "$Flag" + `
let foreign = Channel.CreateBounded[int32](2)
foreign <- 4
let (v, ok) = <-foreign
foreign.Close()
let (z, ok2) = <-foreign
flag(ok) * 100 + v * 10 + flag(ok2) * 1000 + z`))
        Assert.Empty(result.Diagnostics)
        Assert.Equal(140, result.Value)
    }

    shared {
        private const Flag string = `func flag(b bool) int32 {
    if b {
        return 1
    }
    return 0
}`

        private func Bind(source string)(Diagnostics ImmutableArray[Diagnostic], Compilation Compilation) {
            let compilation = Compilation(SyntaxTree.Parse(source))
            return (EmittedOracle.CompileDiagnostics(compilation), compilation)
        }
    }
}
