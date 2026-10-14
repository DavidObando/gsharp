// <copyright file="Adr0174ChanTypeClauseParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// ADR-0174 D2 — the channel type clause is spelled `chan[T]` with the
/// element type inside brackets (like `sequence[T]` and `map[K, V]`),
/// optionally headed by the variance keywords `in` (receive-only) or
/// `out` (send-only). This retires the juxtaposed `chan T` spelling
/// and with it the `(chan T)?` grouping carve-out: `chan[int32]?` and
/// `chan[int32?]` now say the two things directly. The parser still
/// recognizes the legacy shape long enough to emit a span-accurate
/// `GS0567` ("use `chan[T]`") and then binds the canonical form so
/// the file does not cascade — the same recovery ADR-0104 gave `map[K]V`.
open class Adr0174ChanTypeClauseParserTests {
    // --- canonical `chan[T]` in every type-clause slot ---
    @Theory
    @InlineData("var ch chan[int32] = chan[int32](1)")
    @InlineData("let ch = chan[int32](1)")
    @InlineData("let ch = chan[int32]()")
    @InlineData("let ch = chan[string?](2)")
    @InlineData("var ch chan[int32]? = nil")
    @InlineData("var ch chan[int32?]? = nil")
    @InlineData("var chs []chan[int32] = []chan[int32]{}")
    @InlineData("var m map[string, chan[int32]] = map[string, chan[int32]]{}")
    @InlineData("var nested chan[chan[int32]] = chan[chan[int32]](1)")
    @InlineData("var ch chan[(int32, string)] = chan[(int32, string)](1)")
    @InlineData("var ch chan[[]int32] = chan[[]int32](1)")
    @InlineData("var r in chan[int32]? = nil")
    @InlineData("var w out chan[int32]? = nil")
    @InlineData("var g (chan[int32])? = nil")
    func CanonicalSpelling_IsAcceptedInAllTypeClauseSlots(statement string) {
        let source = (`package P
func main() {
    ` + "$statement" + `
}`)
        Assert.Empty(AllParserDiagnostics(source))
    }

    @Fact
    func DirectionalSpellings_InSignatures_NoDiagnostics() {
        const source = `package P

func produce(values []int32) in chan[int32] {
    let out = chan[int32]()
    return out
}

func route(input in chan[int32], evens out chan[int32], odds out chan[int32]) {
}

func both(ch chan[int32]) {
}`
        Assert.Empty(AllParserDiagnostics(source))
    }

    @Fact
    func DirectionalParameter_FollowedByForIn_IsNotConfusable() {
        // `in` heads the channel type in the parameter and heads the loop in
        // the body — the one genuinely confusable line D2 calls out.
        const source = `package P
func drain(ch in chan[int32]) {
    for v in ch {
    }
}`
        Assert.Empty(AllParserDiagnostics(source))
    }

    @Fact
    func DirectionalHead_IsATypeHead_NotATupleElementName() {
        const source = `package P
func main() {
    var pair (in chan[int32], out chan[int32]) = (chan[int32](1), chan[int32](1))
    var named (reader in chan[int32], writer out chan[int32]) = (chan[int32](1), chan[int32](1))
}`
        Assert.Empty(AllParserDiagnostics(source))
        let tree = SyntaxTree.Parse(source)
        let clauses = tree
            .Root
            .DescendantNodes()
            .OfType[TypeClauseSyntax]()
            .Where((t TypeClauseSyntax) -> t.IsChannel)
            .ToArray()
        Assert.Equal(4, clauses.Count((t TypeClauseSyntax) -> t.ChanDirectionToken != nil))
        Assert.All(clauses, (t TypeClauseSyntax) -> Assert.False(t.IsLegacyChanSpelling))
    }

    @Fact
    func Construction_ParsesTypeClauseAppliedToArguments() {
        let tree = SyntaxTree.Parse(`package P
func main() {
    let a = chan[int32]()
    let b = chan[int32](4)
    let c = chan[int32](4).Length()
}`)
        Assert.Empty(tree.Diagnostics)
        let creations = tree.Root.DescendantNodes().OfType[ChannelCreationExpressionSyntax]().ToArray()
        Assert.Equal(3, creations.Length)
        Assert.Equal(0, creations[0].Arguments.Count)
        Assert.Equal(1, creations[1].Arguments.Count)
        Assert.True(creations[0].TypeClause.IsChannel)
        Assert.Null(creations[0].TypeClause.ChanDirectionToken)
    }

    // --- legacy `chan T` is rejected with GS0567 ---
    @Fact
    func LegacySpelling_InLocalDeclaration_ReportsGS0567() {
        const source = `package P
func main() {
    var ch chan int32 = chan[int32](1)
}`
        let d = Assert.Single(LegacyDiagnostics(source))
        Assert.Contains("'chan T' type-clause spelling has been removed", d.Message)
        Assert.Contains("chan[int32]", d.Message)
        Assert.Contains("ADR-0174", d.Message)
    }

    @Fact
    func LegacySpelling_DiagnosticSpan_CoversWholeShape() {
        // The span must run from `chan` through the element type so an IDE
        // quick-fix can replace the whole construct in one edit.
        const source = `package P
func main() {
    var ch chan int32 = chan[int32](1)
}`
        let d = Assert.Single(LegacyDiagnostics(source))
        Assert.Equal("chan int32", d.Location.Text!!.ToString(d.Location.Span))
    }

    @Fact
    func LegacySpelling_WithDirection_SpanIncludesTheDirection() {
        const source = `package P
func f(ch in chan int32) {
}`
        let d = Assert.Single(LegacyDiagnostics(source))
        Assert.Equal("in chan int32", d.Location.Text!!.ToString(d.Location.Span))
        Assert.Contains("chan[int32]", d.Message)
    }

    @Theory
    @InlineData("func makeIt() chan int32 { return chan[int32](1) }", "chan[int32]")
    @InlineData("func take(ch chan string) { }", "chan[string]")
    @InlineData("func (self chan T) Drain[T]() { }", "chan[T]")
    @InlineData("class Box { var ch chan int32? = nil }", "chan[int32?]")
    @InlineData("func main() { let s sequence[chan int32] = nil }", "chan[int32]")
    func LegacySpelling_InEverySlot_ReportsGS0567_NamingTheReplacement(declaration string, replacement string) {
        let source = (`package P
` + "$declaration")
        let d = Assert.Single(LegacyDiagnostics(source))
        Assert.Contains(replacement, d.Message)
    }

    @Fact
    func LegacyNullableElement_RecoversAsChannelOfNullable() {
        // `chan int32?` was `chan (int32?)` (the element parse is greedy); the
        // recovered canonical clause therefore brackets the nullable element.
        let tree = SyntaxTree.Parse(`package P
func main() {
    var ch chan int32? = nil
}`)
        let clause = tree.Root.DescendantNodes().OfType[TypeClauseSyntax]().Single((t TypeClauseSyntax) -> t.IsChannel)
        Assert.True(clause.IsLegacyChanSpelling)
        Assert.NotNull(clause.ChanElementType!!.QuestionToken)
        Assert.Null(clause.QuestionToken)
    }

    @Fact
    func MixedForms_EmitOneDiagnosticPerLegacySite_NoCascade() {
        const source = `package P

func legacyReturn() chan int32 {
    return chan[int32](1)
}

func legacyParam(ch chan string) {
}

func main() {
    var a chan[int32] = chan[int32](1)
    var b chan bool = chan[bool](1)
    var c in chan[int32]? = nil
}`
        let diagnostics = LegacyDiagnostics(source)
        Assert.Equal(3, diagnostics.Length)
        Assert.Empty(SyntaxTree.Parse(source).Diagnostics.Where((d Diagnostic) -> d.Id != LegacyDiagnosticId))
    }

    @Fact
    func MixedForms_EveryDiagnosticCarriesItsOwnReplacement() {
        const source = `package P
func main() {
    var a chan int32 = chan[int32](1)
    var b chan Item = nil
}`
        let diagnostics = LegacyDiagnostics(source)
        Assert.Equal(2, diagnostics.Length)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Message.Contains("chan[int32]"))
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Message.Contains("chan[Item]"))
    }

    // --- the retired `make(chan …)` reports GS0566, once, naming the replacement ---
    @Fact
    func LegacyMake_ReportsGS0566_NamingTheExactReplacement_AndNotGS0567() {
        const source = `package P
func main() {
    let a = make(chan int32, 3)
    let b = make(chan string)
}`
        let tree = SyntaxTree.Parse(source)
        let retired = tree.Diagnostics.Where((d Diagnostic) -> d.Id == "GS0566").ToArray()
        Assert.Equal(2, retired.Length)
        Assert.Empty(tree.Diagnostics.Where((d Diagnostic) -> d.Id == LegacyDiagnosticId))
        Assert.Empty(tree.Diagnostics.Where((d Diagnostic) -> d.Id != "GS0566"))
        let buffered = retired.Single((d Diagnostic) -> d.Message.Contains("make(chan int32, 3)"))
        Assert.Contains("use 'chan[int32](3)' instead", buffered.Message)
        Assert.Equal("make(chan int32, 3)", buffered.Location.Text!!.ToString(buffered.Location.Span))
        let unbounded = retired.Single((d Diagnostic) -> d.Message.Contains("make(chan string)"))
        Assert.Contains("'chan[string]()'", unbounded.Message)
        Assert.Contains("'Chan.Unbounded[string]()'", unbounded.Message)
    }

    shared {
        private const LegacyDiagnosticId string = "GS0567"
        private func AllParserDiagnostics(source string)[]Diagnostic -> SyntaxTree.Parse(source).Diagnostics.ToArray()

        private func LegacyDiagnostics(source string)[]Diagnostic -> SyntaxTree
            .Parse(source)
            .Diagnostics
            .Where((d Diagnostic) -> d.Id == LegacyDiagnosticId)
            .ToArray()
    }
}
