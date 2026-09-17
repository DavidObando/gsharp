// <copyright file="NullConditionalChainTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Direct unit coverage for <see cref="NullConditionalChain"/> (issue #4173):
/// every formula here was cross-checked empirically against a real Roslyn
/// parse of the structurally equivalent C# during development (see the
/// type's own doc comments) — these tests pin that cross-check down as a
/// regression guard, independent of whatever cs2gs analyzer idiom happens to
/// exercise the helper today (<c>Cs2Gs.Tests</c>'s
/// <c>Issue4173NullConditionalAnalyzerMappingTests</c>). Only PARSED shape
/// matters for every function under test — none of it binds — so the
/// expressions below are syntactically valid but semantically arbitrary,
/// wrapped in a statement position (<c>_ = &lt;expr&gt;</c>) that accepts
/// anything. Assertions compare SLICED SOURCE TEXT rather than hard-coded
/// absolute offsets, so they stay correct regardless of this file's own
/// surrounding source layout.
/// </summary>
public sealed class NullConditionalChainTests
{
    private const string Preamble = "package sample\nfunc F()\n{\n    var x = ";

    private static (string Source, ExpressionSyntax Top) ParseExpression(string bodyExpression)
    {
        string source = Preamble + bodyExpression + "\n}\n";
        SyntaxTree tree = SyntaxTree.Parse(SourceText.From(source, "test.gs"));
        Assert.True(tree.Diagnostics.IsEmpty, string.Join("\n", tree.Diagnostics.Select(d => d.Message)) + "\n" + source);
        ExpressionSyntax initializer = tree.Root.DescendantNodes()
            .OfType<VariableDeclarationSyntax>()
            .First()
            .Initializer;
        return (source, NullConditionalChain.ChainTop(initializer));
    }

    private static ExpressionSyntax[] HopsInSourceOrder(SyntaxNode top)
    {
        var found = new List<ExpressionSyntax>();
        void Walk(SyntaxNode node)
        {
            if (NullConditionalChain.IsNullConditionalHop(node))
            {
                found.Add((ExpressionSyntax)node);
            }

            foreach (SyntaxNode child in node.GetChildren())
            {
                if (child is not SyntaxToken)
                {
                    Walk(child);
                }
            }
        }

        Walk(top);
        return found
            .OrderBy(h => NullConditionalChain.NullConditionalOperatorToken(h).Span.Start)
            .ToArray();
    }

    private static string Slice(string source, TextSpan span) => source.Substring(span.Start, span.Length);

    [Fact]
    public void TwoLevelChain_HopReceiverAndWhenNotNullSpansMatchRoslyn()
    {
        // a?.b?.c (Roslyn control, from the design investigation): CAE1.Span
        // is the whole chain, CAE1.Expression is the bare root, CAE1.WhenNotNull
        // is everything after the first '?'; CAE2 (nested in CAE1.WhenNotNull)
        // has the SAME end but starts right after CAE1's own '?', its
        // Expression is the bare receiverless binding '.b', and its
        // WhenNotNull is the bare tail '.c'.
        (string source, ExpressionSyntax top) = ParseExpression("a?.b?.c");
        ExpressionSyntax[] hops = HopsInSourceOrder(top);
        Assert.Equal(2, hops.Length);
        ExpressionSyntax outer = hops[0];
        ExpressionSyntax inner = hops[1];

        Assert.Same(top, outer);
        Assert.True(NullConditionalChain.IsChainRoot(outer));
        Assert.False(NullConditionalChain.IsChainRoot(inner));
        Assert.Same(outer, NullConditionalChain.ChainTop(inner));
        Assert.Same(inner, NullConditionalChain.NextNullConditionalHop(outer));
        Assert.Null(NullConditionalChain.NextNullConditionalHop(inner));

        Assert.Equal("a?.b?.c", Slice(source, NullConditionalChain.HopSpan(outer)));
        Assert.Equal(".b?.c", Slice(source, NullConditionalChain.HopSpan(inner)));
        Assert.Equal("a", Slice(source, NullConditionalChain.ReceiverSpan(outer)));
        Assert.Equal(".b", Slice(source, NullConditionalChain.ReceiverSpan(inner)));
        Assert.Equal(".b?.c", Slice(source, NullConditionalChain.WhenNotNullSpan(outer)));
        Assert.Equal(".c", Slice(source, NullConditionalChain.WhenNotNullSpan(inner)));

        Assert.False(NullConditionalChain.TailIsMemberBinding(outer));
        Assert.True(NullConditionalChain.TailIsMemberBinding(inner));
        Assert.False(NullConditionalChain.ReceiverIsMemberBinding(outer));
        Assert.True(NullConditionalChain.ReceiverIsMemberBinding(inner));
        Assert.False(NullConditionalChain.ReceiverIsPlainMemberAccess(inner));
        Assert.False(NullConditionalChain.ReceiverIsElementBinding(inner));
    }

    [Fact]
    public void MixedOrdinaryThenConditional_TailIsNotMemberBinding()
    {
        // a?.b.c (row 5's shape): single NC hop; the WhenNotNull is an
        // ORDINARY continuation, not a bare tail, so TailIsMemberBinding is
        // false — this is the exact shape the removed idiom over-fired on.
        (string source, ExpressionSyntax top) = ParseExpression("a?.b.c");
        ExpressionSyntax[] hops = HopsInSourceOrder(top);
        ExpressionSyntax onlyHop = Assert.Single(hops);
        Assert.Same(top, onlyHop);

        Assert.False(NullConditionalChain.TailIsMemberBinding(onlyHop));
        Assert.Equal("a?.b.c", Slice(source, NullConditionalChain.HopSpan(onlyHop)));
        Assert.Equal("a", Slice(source, NullConditionalChain.ReceiverSpan(onlyHop)));
    }

    [Fact]
    public void DeeperMixedChain_ReceiverSpanSkipsOnlyThePrecedingHopsQuestionMark()
    {
        // a?.b.c.d?.e: the SECOND hop's receiver ("b.c.d") skips only the
        // '?' that belongs to the FIRST hop, no matter how many ordinary
        // steps lie between them (Roslyn control from the design
        // investigation: CAE2.Expression == ".b.c.d", 6 characters).
        (string source, ExpressionSyntax top) = ParseExpression("a?.b.c.d?.e");
        ExpressionSyntax[] hops = HopsInSourceOrder(top);
        Assert.Equal(2, hops.Length);
        ExpressionSyntax outer = hops[0];
        ExpressionSyntax inner = hops[1];

        Assert.Equal("a", Slice(source, NullConditionalChain.ReceiverSpan(outer)));
        Assert.Equal(".b.c.d", Slice(source, NullConditionalChain.ReceiverSpan(inner)));
        Assert.Equal("a?.b.c.d?.e", Slice(source, NullConditionalChain.HopSpan(outer)));
        Assert.Equal(".b.c.d?.e", Slice(source, NullConditionalChain.HopSpan(inner)));
        Assert.True(NullConditionalChain.ReceiverIsPlainMemberAccess(inner));
        Assert.False(NullConditionalChain.ReceiverIsMemberBinding(inner));
    }

    [Fact]
    public void ElementHopThenMemberHop_ReceiverIsElementBindingAndTailExcludesTheWrappedElementHop()
    {
        // a?[i]?.b: the element hop is TAIL-EXCLUDED once the member hop
        // wraps it as its LeftPart (TailIsElementBinding false there, since
        // [/?[ nests the ordinary iterative way), and the member hop's
        // receiver is the preceding element hop (ReceiverIsElementBinding).
        (string source, ExpressionSyntax top) = ParseExpression("a?[i]?.b");
        ExpressionSyntax[] hops = HopsInSourceOrder(top);
        Assert.Equal(2, hops.Length);
        ExpressionSyntax elementHop = hops[0];
        ExpressionSyntax memberHop = hops[1];

        Assert.False(NullConditionalChain.TailIsElementBinding(elementHop));
        Assert.True(NullConditionalChain.TailIsMemberBinding(memberHop));
        Assert.True(NullConditionalChain.ReceiverIsElementBinding(memberHop));
        Assert.False(NullConditionalChain.ReceiverIsMemberBinding(memberHop));
        Assert.Equal("a", Slice(source, NullConditionalChain.ReceiverSpan(elementHop)));
        Assert.Equal("[i]", Slice(source, NullConditionalChain.ReceiverSpan(memberHop)));
    }

    [Fact]
    public void MemberHopThenElementHop_TailIsElementBindingAndReceiverIsMemberBinding()
    {
        // a?.b?[i]: the element hop here is the TOP of the chain (nothing
        // wraps it further), so it IS the tail — TailIsElementBinding true —
        // and its receiver continues directly off the preceding member hop.
        (string source, ExpressionSyntax top) = ParseExpression("a?.b?[i]");
        ExpressionSyntax[] hops = HopsInSourceOrder(top);
        Assert.Equal(2, hops.Length);
        ExpressionSyntax memberHop = hops[0];
        ExpressionSyntax elementHop = hops[1];

        Assert.False(NullConditionalChain.TailIsMemberBinding(memberHop));
        Assert.True(NullConditionalChain.TailIsElementBinding(elementHop));
        Assert.True(NullConditionalChain.ReceiverIsMemberBinding(elementHop));
        Assert.False(NullConditionalChain.ReceiverIsElementBinding(elementHop));
        Assert.Equal(".b", Slice(source, NullConditionalChain.ReceiverSpan(elementHop)));
    }

    [Fact]
    public void SinglePlainHop_IsChainRootAndTailIsMemberBinding()
    {
        (string source, ExpressionSyntax top) = ParseExpression("a?.b");
        ExpressionSyntax hop = Assert.Single(HopsInSourceOrder(top));
        Assert.Same(top, hop);
        Assert.True(NullConditionalChain.IsChainRoot(hop));
        Assert.True(NullConditionalChain.TailIsMemberBinding(hop));
        Assert.False(NullConditionalChain.TailIsElementBinding(hop));
        Assert.Equal("a?.b", Slice(source, NullConditionalChain.HopSpan(hop)));
        Assert.Equal("a", Slice(source, NullConditionalChain.ReceiverSpan(hop)));
        Assert.Same(hop, NullConditionalChain.AsNullConditionalHop(hop));
        Assert.Null(NullConditionalChain.AsNullConditionalHop(NullConditionalChain.NullConditionalReceiver(hop)));
    }

    [Fact]
    public void OrdinaryAccess_IsNotANullConditionalHop()
    {
        (_, ExpressionSyntax top) = ParseExpression("a.b.c");
        Assert.Empty(HopsInSourceOrder(top));
        Assert.False(NullConditionalChain.IsNullConditionalHop(top));
        Assert.Null(NullConditionalChain.AsNullConditionalHop(top));
    }

    /// <summary>
    /// Issue #4173 round 3, §4.6: <see cref="NullConditionalChain.HopSpan"/> and
    /// <see cref="NullConditionalChain.ReceiverSpan"/> yield a plausible but
    /// meaningless span for a non-hop node, so both now guard their precondition
    /// explicitly rather than silently computing a bogus answer.
    /// </summary>
    [Fact]
    public void HopSpanAndReceiverSpan_ThrowOnNonHopNode()
    {
        (_, ExpressionSyntax top) = ParseExpression("a.b.c");
        Assert.False(NullConditionalChain.IsNullConditionalHop(top));

        Assert.Throws<System.ArgumentException>(() => NullConditionalChain.HopSpan(top));
        Assert.Throws<System.ArgumentException>(() => NullConditionalChain.ReceiverSpan(top));
    }
}
