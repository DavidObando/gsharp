// <copyright file="NullConditionalChainTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Linq
import Xunit

/// Direct unit coverage for (cref:NullConditionalChain) (issue #4173):
/// every formula here was cross-checked empirically against a real Roslyn
/// parse of the structurally equivalent C# during development (see the
/// type's own doc comments) — these tests pin that cross-check down as a
/// regression guard, independent of whatever cs2gs analyzer idiom happens to
/// exercise the helper today (`Cs2Gs.Tests`'s
/// `Issue4173NullConditionalAnalyzerMappingTests`). Only PARSED shape
/// matters for every function under test — none of it binds — so the
/// expressions below are syntactically valid but semantically arbitrary,
/// wrapped in a statement position (`_ = <expr>`) that accepts
/// anything. Assertions compare SLICED SOURCE TEXT rather than hard-coded
/// absolute offsets, so they stay correct regardless of this file's own
/// surrounding source layout.
class NullConditionalChainTests {
    @Fact
    func TwoLevelChain_HopReceiverAndWhenNotNullSpansMatchRoslyn() {
        // a?.b?.c (Roslyn control, from the design investigation): CAE1.Span
        // is the whole chain, CAE1.Expression is the bare root, CAE1.WhenNotNull
        // is everything after the first '?'; CAE2 (nested in CAE1.WhenNotNull)
        // has the SAME end but starts right after CAE1's own '?', its
        // Expression is the bare receiverless binding '.b', and its
        // WhenNotNull is the bare tail '.c'.
        let (source, top) = ParseExpression("a?.b?.c")
        let hops = HopsInSourceOrder(top)
        Assert.Equal(2, hops.Length)
        let outer = hops[0]
        let inner = hops[1]
        Assert.Same(top, outer)
        Assert.True(NullConditionalChain.IsChainRoot(outer))
        Assert.False(NullConditionalChain.IsChainRoot(inner))
        Assert.Same(outer, NullConditionalChain.ChainTop(inner))
        Assert.Same(inner, NullConditionalChain.NextNullConditionalHop(outer))
        Assert.Null(NullConditionalChain.NextNullConditionalHop(inner))
        Assert.Equal("a?.b?.c", Slice(source, NullConditionalChain.HopSpan(outer)))
        Assert.Equal(".b?.c", Slice(source, NullConditionalChain.HopSpan(inner)))
        Assert.Equal("a", Slice(source, NullConditionalChain.ReceiverSpan(outer)))
        Assert.Equal(".b", Slice(source, NullConditionalChain.ReceiverSpan(inner)))
        Assert.Equal(".b?.c", Slice(source, NullConditionalChain.WhenNotNullSpan(outer)))
        Assert.Equal(".c", Slice(source, NullConditionalChain.WhenNotNullSpan(inner)))
        Assert.False(NullConditionalChain.TailIsMemberBinding(outer))
        Assert.True(NullConditionalChain.TailIsMemberBinding(inner))
        Assert.False(NullConditionalChain.ReceiverIsMemberBinding(outer))
        Assert.True(NullConditionalChain.ReceiverIsMemberBinding(inner))
        Assert.False(NullConditionalChain.ReceiverIsPlainMemberAccess(inner))
        Assert.False(NullConditionalChain.ReceiverIsElementBinding(inner))
    }

    @Fact
    func MixedOrdinaryThenConditional_TailIsNotMemberBinding() {
        // a?.b.c (row 5's shape): single NC hop; the WhenNotNull is an
        // ORDINARY continuation, not a bare tail, so TailIsMemberBinding is
        // false — this is the exact shape the removed idiom over-fired on.
        let (source, top) = ParseExpression("a?.b.c")
        let hops = HopsInSourceOrder(top)
        let onlyHop = Assert.Single(hops)
        Assert.Same(top, onlyHop)
        Assert.False(NullConditionalChain.TailIsMemberBinding(onlyHop))
        Assert.Equal("a?.b.c", Slice(source, NullConditionalChain.HopSpan(onlyHop)))
        Assert.Equal("a", Slice(source, NullConditionalChain.ReceiverSpan(onlyHop)))
    }

    @Fact
    func DeeperMixedChain_ReceiverSpanSkipsOnlyThePrecedingHopsQuestionMark() {
        // a?.b.c.d?.e: the SECOND hop's receiver ("b.c.d") skips only the
        // '?' that belongs to the FIRST hop, no matter how many ordinary
        // steps lie between them (Roslyn control from the design
        // investigation: CAE2.Expression == ".b.c.d", 6 characters).
        let (source, top) = ParseExpression("a?.b.c.d?.e")
        let hops = HopsInSourceOrder(top)
        Assert.Equal(2, hops.Length)
        let outer = hops[0]
        let inner = hops[1]
        Assert.Equal("a", Slice(source, NullConditionalChain.ReceiverSpan(outer)))
        Assert.Equal(".b.c.d", Slice(source, NullConditionalChain.ReceiverSpan(inner)))
        Assert.Equal("a?.b.c.d?.e", Slice(source, NullConditionalChain.HopSpan(outer)))
        Assert.Equal(".b.c.d?.e", Slice(source, NullConditionalChain.HopSpan(inner)))
        Assert.True(NullConditionalChain.ReceiverIsPlainMemberAccess(inner))
        Assert.False(NullConditionalChain.ReceiverIsMemberBinding(inner))
    }

    @Fact
    func ElementHopThenMemberHop_ReceiverIsElementBindingAndTailExcludesTheWrappedElementHop() {
        // a?[i]?.b: the element hop is TAIL-EXCLUDED once the member hop
        // wraps it as its LeftPart (TailIsElementBinding false there, since
        // [/?[ nests the ordinary iterative way), and the member hop's
        // receiver is the preceding element hop (ReceiverIsElementBinding).
        let (source, top) = ParseExpression("a?[i]?.b")
        let hops = HopsInSourceOrder(top)
        Assert.Equal(2, hops.Length)
        let elementHop = hops[0]
        let memberHop = hops[1]
        Assert.False(NullConditionalChain.TailIsElementBinding(elementHop))
        Assert.True(NullConditionalChain.TailIsMemberBinding(memberHop))
        Assert.True(NullConditionalChain.ReceiverIsElementBinding(memberHop))
        Assert.False(NullConditionalChain.ReceiverIsMemberBinding(memberHop))
        Assert.Equal("a", Slice(source, NullConditionalChain.ReceiverSpan(elementHop)))
        Assert.Equal("[i]", Slice(source, NullConditionalChain.ReceiverSpan(memberHop)))
    }

    @Fact
    func MemberHopThenElementHop_TailIsElementBindingAndReceiverIsMemberBinding() {
        // a?.b?[i]: the element hop here is the TOP of the chain (nothing
        // wraps it further), so it IS the tail — TailIsElementBinding true —
        // and its receiver continues directly off the preceding member hop.
        let (source, top) = ParseExpression("a?.b?[i]")
        let hops = HopsInSourceOrder(top)
        Assert.Equal(2, hops.Length)
        let memberHop = hops[0]
        let elementHop = hops[1]
        Assert.False(NullConditionalChain.TailIsMemberBinding(memberHop))
        Assert.True(NullConditionalChain.TailIsElementBinding(elementHop))
        Assert.True(NullConditionalChain.ReceiverIsMemberBinding(elementHop))
        Assert.False(NullConditionalChain.ReceiverIsElementBinding(elementHop))
        Assert.Equal(".b", Slice(source, NullConditionalChain.ReceiverSpan(elementHop)))
    }

    @Fact
    func SinglePlainHop_IsChainRootAndTailIsMemberBinding() {
        let (source, top) = ParseExpression("a?.b")
        let hop = Assert.Single(HopsInSourceOrder(top))
        Assert.Same(top, hop)
        Assert.True(NullConditionalChain.IsChainRoot(hop))
        Assert.True(NullConditionalChain.TailIsMemberBinding(hop))
        Assert.False(NullConditionalChain.TailIsElementBinding(hop))
        Assert.Equal("a?.b", Slice(source, NullConditionalChain.HopSpan(hop)))
        Assert.Equal("a", Slice(source, NullConditionalChain.ReceiverSpan(hop)))
        Assert.Same(hop, NullConditionalChain.AsNullConditionalHop(hop))
        Assert.Null(NullConditionalChain.AsNullConditionalHop(NullConditionalChain.NullConditionalReceiver(hop)))
    }

    @Fact
    func OrdinaryAccess_IsNotANullConditionalHop() {
        let (_, top) = ParseExpression("a.b.c")
        Assert.Empty(HopsInSourceOrder(top))
        Assert.False(NullConditionalChain.IsNullConditionalHop(top))
        Assert.Null(NullConditionalChain.AsNullConditionalHop(top))
    }

    /// Issue #4173 round 3, §4.6: (cref:NullConditionalChain.HopSpan) and
    /// (cref:NullConditionalChain.ReceiverSpan) yield a plausible but
    /// meaningless span for a non-hop node, so both now guard their precondition
    /// explicitly rather than silently computing a bogus answer.
    @Fact
    func HopSpanAndReceiverSpan_ThrowOnNonHopNode() {
        let (_, top) = ParseExpression("a.b.c")
        Assert.False(NullConditionalChain.IsNullConditionalHop(top))
        Assert.Throws[ArgumentException](
            func () object? {
                return NullConditionalChain.HopSpan(top)
            }
        )
        Assert.Throws[ArgumentException](
            func () object? {
                return NullConditionalChain.ReceiverSpan(top)
            }
        )
    }

    shared {
        private const Preamble string = `package sample
func F()
{
    var x = `

        private func ParseExpression(bodyExpression string)(Source string, Top ExpressionSyntax) {
            let source = Preamble + bodyExpression + `
}
`
            let tree = SyntaxTree.Parse(SourceText.From(source, "test.gs"))
            Assert.True(
                tree.Diagnostics.IsEmpty,
                string.Join("\n", tree.Diagnostics.Select((d Diagnostic) -> d.Message)) + "\n" + source
            )
            let initializer ExpressionSyntax? = tree
                .Root
                .DescendantNodes()
                .OfType[VariableDeclarationSyntax]()
                .First()
                .Initializer
            return (source, NullConditionalChain.ChainTop(initializer!!))
        }

        private func HopsInSourceOrder(top SyntaxNode)[]ExpressionSyntax {
            let found = List[ExpressionSyntax]()
            let Walk = func (node SyntaxNode) {
                if NullConditionalChain.IsNullConditionalHop(node) {
                    found.Add(cast[ExpressionSyntax](node))
                }
                for child in node.GetChildren() {
                    if !(child is SyntaxToken) {
                        Walk(child)
                    }
                }
            }
            Walk(top)
            return found.OrderBy(
                (h ExpressionSyntax) -> NullConditionalChain.NullConditionalOperatorToken(h).Span.Start
            )
                .ToArray()
        }

        private func Slice(source string, span TextSpan) string -> source.Substring(span.Start, span.Length)
    }
}
