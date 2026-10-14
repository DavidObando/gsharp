// <copyright file="Adr0174SelectArmOperandParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// A select arm's operand sits immediately before the arm's body brace, so a
/// call- or indexer-tailed operand used to read that brace as its own object
/// initializer and swallow the body — issue #1023's defect (fixed there for a
/// C-style `for`'s increment) in another position, found while rebuilding
/// `select` for ADR-0174 D8.
/// @remarks Discrimination witness (ADR-0154): a mutant that parses the operand with the
/// ordinary expression parser (no trailing-initializer suppression) reports
/// `GS0005` here — the brace is consumed as an initializer and the arm's
/// statements are read as member assignments.
open class Adr0174SelectArmOperandParserTests {
    @Theory
    @InlineData(`case ch <- Pair(41) {
        used = 1
    }`)
    @InlineData(`case ch <- values[0] {
        used = 1
    }`)
    @InlineData(`case let got = <-boxes[0] {
        used = got
    }`)
    @InlineData(`case <-boxes[0] {
        used = 1
    }`)
    func AnArmOperandDoesNotSwallowTheArmBody(arm string) {
        let source = (`package P
data struct Pair(Value int32)

func run(values []Pair, boxes []chan[int32], ch chan[Pair]) int32 {
    var used = 0
    select {
    ` + "$arm" + `
    }

    return used
}`)
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics.Where((diagnostic Diagnostic) -> diagnostic.IsError))
    }

    @Theory
    @InlineData("case <-ch { }")
    @InlineData("case let got = <-ch { }")
    @InlineData("case ch <- got { }")
    @InlineData("case <-ch when got > 0 { }")
    func AnEmptyArmBodyIsNotAnEmptyStructLiteral(arm string) {
        // The other half of the same ambiguity (issue #1575's shape): a name
        // operand followed by an empty `{ }` is an arm with an empty body, not
        // a construction of a type called `ch`.
        let source = (`package P
func run(ch chan[int32], got int32) int32 {
    select {
    ` + "$arm" + `
    default { }
    }

    return got
}`)
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics.Where((diagnostic Diagnostic) -> diagnostic.IsError))
    }

    @Fact
    func ANonEmptyStructLiteralIsStillAnArmOperand() {
        // Suppression stops at the genuinely ambiguous shape: `Pair{Value: 41}`
        // cannot open a body, so it stays a struct literal.
        let source = `package P
data struct Pair(Value int32)

func run(ch chan[Pair]) int32 {
    var used = 0
    select {
    case ch <- Pair{Value: 41} {
        used = 1
    }
    }

    return used
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics.Where((diagnostic Diagnostic) -> diagnostic.IsError))
    }
}
