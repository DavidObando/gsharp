// <copyright file="NullConditionalChain.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Structural helpers over a G# null-conditional access chain (<c>?.</c> /
/// <c>?[</c>), written for a migrated Roslyn analyzer (issue #4173) that used
/// to walk Roslyn's <c>ConditionalAccessExpressionSyntax</c> /
/// <c>MemberBindingExpressionSyntax</c> / <c>ElementBindingExpressionSyntax</c>
/// shapes and needs the G# equivalent at analysis time.
/// <para>
/// <b>Shape.</b> G# gives <c>a?.b</c> and <c>a.b</c> the SAME node
/// (<see cref="AccessorExpressionSyntax"/>), told apart only by
/// <see cref="AccessorExpressionSyntax.IsNullConditional"/>; <c>a?[i]</c> is
/// <see cref="IndexExpressionSyntax"/> with its own
/// <see cref="IndexExpressionSyntax.IsNullConditional"/>. A "hop" below always
/// means one such flagged node — the G# counterpart of one Roslyn
/// <c>ConditionalAccessExpressionSyntax</c> (one <c>?.</c>/<c>?[</c>
/// operator).
/// </para>
/// <para>
/// <b>Nesting is NOT a mirror image of Roslyn's, and it is not uniform.</b>
/// An earlier draft of this file assumed G#'s postfix chain nests via
/// <c>LeftPart</c> the way a naive left-to-right reading of
/// <c>Parser.Expressions.cs</c>'s <c>current = new X(current, …)</c> pattern
/// suggests. Empirically that is wrong for <c>.</c>/<c>?.</c>: parsing the
/// right-hand side of a dot recurses back into the full postfix grammar
/// (<c>ParseMemberContinuation</c> → <c>ParseNameOrCallExpression</c> → its
/// own <c>ParsePostfixChain</c>) BEFORE the enclosing loop iteration
/// finishes, so that recursive call already swallows every following
/// <c>.</c>/<c>?.</c>/<c>[</c>/<c>(</c>. The result is that a dotted chain
/// nests through <see cref="AccessorExpressionSyntax.RightPart"/> — right/
/// suffix-nested, exactly like Roslyn's own
/// <c>ConditionalAccessExpressionSyntax.WhenNotNull</c> chain — while
/// <c>[</c>/<c>?[</c>/<c>(</c> continuations still nest the ordinary
/// iterative way, through <see cref="IndexExpressionSyntax.Target"/> /
/// <see cref="Syntax.CallExpressionSyntax.Callee"/> (left-nested, the
/// receiver-so-far). <see cref="AssignmentTargetSyntaxFacts.TryLiftTrailingMemberAccess(ExpressionSyntax, out ExpressionSyntax, out SyntaxToken, out SyntaxToken)"/>
/// already relies on this same right-nesting for member-access chains and is
/// a second, independent confirmation.
/// </para>
/// <para>
/// Because of that split, "does node <c>n</c> have a further hop wrapping
/// it" is not one simple parent check: an inner <c>.</c>/<c>?.</c> hop is a
/// DESCENDANT of the chain's outer node (reached via <c>RightPart</c>), not
/// an ancestor. Every method here is built on two primitives that stay
/// correct regardless of which way a given link nests:
/// <see cref="ChainTop(SyntaxNode)"/> (walk up through every kind of chain
/// link to the outermost node) and an internal left-to-right token-order
/// scan of the hops underneath that top (rather than a literal parent/child
/// walk) for "next hop" queries.
/// </para>
/// </summary>
public static class NullConditionalChain
{
    /// <summary>
    /// True when <paramref name="node"/> is one null-conditional operator —
    /// the G# counterpart of one Roslyn <c>ConditionalAccessExpressionSyntax</c>.
    /// </summary>
    /// <param name="node">The candidate node.</param>
    /// <returns>True for an <see cref="AccessorExpressionSyntax"/> or <see cref="IndexExpressionSyntax"/> with <c>IsNullConditional</c> set.</returns>
    public static bool IsNullConditionalHop(SyntaxNode? node) => node switch
    {
        AccessorExpressionSyntax { IsNullConditional: true } => true,
        IndexExpressionSyntax { IsNullConditional: true } => true,
        _ => false,
    };

    /// <summary>
    /// <paramref name="node"/> as a null-conditional hop, or <see langword="null"/>
    /// when it is not one. The G# counterpart of Roslyn's
    /// <c>expr is ConditionalAccessExpressionSyntax x</c> type test — it
    /// matches <c>?.</c> AND <c>?[</c> uniformly, where the naive
    /// <c>AccessorExpressionSyntax {'{'} IsNullConditional: true {'}'}</c>
    /// pattern alone under-matches <c>a?[i]</c>.
    /// </summary>
    /// <param name="node">The candidate node.</param>
    /// <returns>The node as an <see cref="ExpressionSyntax"/> hop, or null.</returns>
    public static ExpressionSyntax? AsNullConditionalHop(SyntaxNode? node)
        => IsNullConditionalHop(node) ? (ExpressionSyntax)node! : null;

    /// <summary>
    /// The immediate receiver of one hop (<see cref="AccessorExpressionSyntax.LeftPart"/>
    /// / <see cref="IndexExpressionSyntax.Target"/>) — the G# counterpart of
    /// Roslyn's <c>ConditionalAccessExpressionSyntax.Expression</c>.
    /// <para>
    /// Exact only for the FIRST hop of a chain (there, it is the genuine,
    /// independently-evaluated receiver — see
    /// <c>ExpressionBinder.Access.Accessor.cs</c>'s
    /// <c>BindNullConditionalAccessExpression</c>, which binds
    /// <c>syntax.LeftPart</c> as a standalone expression). For a LATER hop in
    /// the same chain, G# reuses the same <c>LeftPart</c> slot to hold just
    /// the next member NAME (the binder threads the real receiver value
    /// through a synthetic capture instead, with no syntax node of its own)
    /// — value-equivalent to what Roslyn's receiverless
    /// <c>MemberBindingExpressionSyntax</c>/<c>ElementBindingExpressionSyntax</c>
    /// denotes there, but not extent- or lifted-type-exact. Callers that
    /// read a LOCATION off this (I3a) get the Roslyn-exact span from
    /// <see cref="ReceiverSpan(SyntaxNode)"/> instead.
    /// </para>
    /// </summary>
    /// <param name="hop">A null-conditional hop.</param>
    /// <returns>The hop's receiver expression.</returns>
    public static ExpressionSyntax NullConditionalReceiver(SyntaxNode hop) => hop switch
    {
        AccessorExpressionSyntax accessor => accessor.LeftPart,
        IndexExpressionSyntax index => index.Target,
        _ => throw new ArgumentException("Node is not a null-conditional hop.", nameof(hop)),
    };

    /// <summary>
    /// True when <paramref name="node"/> sits at the outermost position of
    /// its postfix chain — nothing (<c>.</c>/<c>?.</c>/<c>[</c>/<c>?[</c>/<c>(</c>,
    /// or a synthesized <c>-&gt;</c> dereference) wraps it further.
    /// </summary>
    /// <param name="node">The candidate node.</param>
    /// <returns>True when there is no chain-extending parent.</returns>
    public static bool IsChainRoot(SyntaxNode node) => !TryGetChainExtendingParent(node, out _);

    /// <summary>
    /// Walks chain-extending parents to the outermost node of the whole
    /// postfix chain <paramref name="node"/> participates in.
    /// </summary>
    /// <param name="node">Any node inside a postfix chain.</param>
    /// <returns>The chain's outermost expression.</returns>
    public static ExpressionSyntax ChainTop(SyntaxNode node)
    {
        SyntaxNode current = node;
        while (TryGetChainExtendingParent(current, out SyntaxNode? parent))
        {
            current = parent!;
        }

        return (ExpressionSyntax)current;
    }

    /// <summary>
    /// The next null-conditional hop reached after <paramref name="hop"/>
    /// when the whole chain is read left to right — the G# counterpart of
    /// Roslyn's <c>WhenNotNull is ConditionalAccessExpressionSyntax</c> (a
    /// further <c>?.</c>/<c>?[</c> later in the same chain, possibly past
    /// intervening ordinary <c>.</c>/<c>[</c> steps). Because G#'s dotted
    /// continuations nest through <c>RightPart</c> (a later operator is a
    /// DESCENDANT, not an ancestor — see the type-level remarks), this is a
    /// left-to-right scan of the chain's hops, not a parent walk.
    /// </summary>
    /// <param name="hop">A null-conditional hop.</param>
    /// <returns>The next hop in source order, or null when <paramref name="hop"/> is last.</returns>
    public static ExpressionSyntax? NextNullConditionalHop(SyntaxNode hop)
    {
        IReadOnlyList<ExpressionSyntax> hops = HopsInChain(ChainTop(hop));
        int index = IndexOfHop(hops, hop);
        return index >= 0 && index + 1 < hops.Count ? hops[index + 1] : null;
    }

    /// <summary>
    /// True when <paramref name="hop"/> is the LAST operator of its chain
    /// and ends directly in a plain member name — the G# counterpart of
    /// Roslyn's <c>WhenNotNull is MemberBindingExpressionSyntax</c>.
    /// </summary>
    /// <param name="hop">A null-conditional hop.</param>
    /// <returns>True for a terminal <c>?.name</c> hop.</returns>
    public static bool TailIsMemberBinding(SyntaxNode hop)
        => hop is AccessorExpressionSyntax { IsNullConditional: true, RightPart: NameExpressionSyntax };

    /// <summary>
    /// True when <paramref name="hop"/> is the LAST operator of its chain
    /// and is an element access — the G# counterpart of Roslyn's
    /// <c>WhenNotNull is ElementBindingExpressionSyntax</c>.
    /// <para>
    /// Unlike <see cref="TailIsMemberBinding(SyntaxNode)"/> this cannot be
    /// read off <paramref name="hop"/> alone: <c>[</c>/<c>?[</c> nests the
    /// ORDINARY (left/iterative) way, so a FURTHER step after an index hop
    /// shows up as that index sitting in a chain-extending PARENT's
    /// <c>LeftPart</c>/<c>Target</c>/<c>Callee</c> — being wrapped as a
    /// parent's <c>RightPart</c> does not disqualify it (that parent is
    /// simply the dot that reached this index, not a further step past it).
    /// </para>
    /// </summary>
    /// <param name="hop">A null-conditional hop.</param>
    /// <returns>True for a terminal <c>?[…]</c> hop.</returns>
    public static bool TailIsElementBinding(SyntaxNode hop)
        => hop is IndexExpressionSyntax { IsNullConditional: true } && !IsInLeftNestingPosition(hop);

    /// <summary>
    /// True when <paramref name="hop"/>'s receiver is itself the PLAIN name
    /// half of an immediately preceding <c>?.</c> — the G# counterpart of
    /// Roslyn's <c>Expression is MemberBindingExpressionSyntax</c>. Because
    /// dotted continuations nest via <c>RightPart</c>, this is a check of
    /// <paramref name="hop"/>'s PARENT (the dot that produced this hop's
    /// name), not of <see cref="NullConditionalReceiver(SyntaxNode)"/>'s
    /// shape.
    /// </summary>
    /// <param name="hop">A null-conditional hop.</param>
    /// <returns>True when the hop continues directly off a preceding <c>?.</c> with no ordinary step in between.</returns>
    public static bool ReceiverIsMemberBinding(SyntaxNode hop)
        => hop.Parent is AccessorExpressionSyntax { IsNullConditional: true } parent
           && ReferenceEquals(parent.RightPart, hop);

    /// <summary>
    /// True when <paramref name="hop"/>'s receiver is itself the plain name
    /// half of an immediately preceding ORDINARY (non-null-conditional)
    /// <c>.</c> — the G# counterpart of Roslyn's <c>Expression is
    /// MemberAccessExpressionSyntax</c>.
    /// </summary>
    /// <param name="hop">A null-conditional hop.</param>
    /// <returns>True when the hop continues directly off a preceding ordinary <c>.</c>.</returns>
    public static bool ReceiverIsPlainMemberAccess(SyntaxNode hop)
        => hop.Parent is AccessorExpressionSyntax { IsNullConditional: false } parent
           && ReferenceEquals(parent.RightPart, hop);

    /// <summary>
    /// True when <paramref name="hop"/>'s receiver is itself a
    /// null-conditional element-access hop — the G# counterpart of Roslyn's
    /// <c>Expression is ElementBindingExpressionSyntax</c>. Unlike the
    /// member-binding checks above, <c>[</c>/<c>?[</c> nests the ordinary
    /// (left/iterative) way, so a preceding index hop shows up directly as
    /// <see cref="NullConditionalReceiver(SyntaxNode)"/>, not as a parent.
    /// </summary>
    /// <param name="hop">A null-conditional hop.</param>
    /// <returns>True when the hop continues directly off a preceding <c>?[…]</c>.</returns>
    public static bool ReceiverIsElementBinding(SyntaxNode hop)
        => NullConditionalReceiver(hop) is IndexExpressionSyntax { IsNullConditional: true };

    /// <summary>
    /// The Roslyn-exact span of <paramref name="hop"/>'s corresponding
    /// <c>ConditionalAccessExpressionSyntax</c>: it starts where the
    /// previous hop's <c>?</c> ends (or, for the first hop, at the natural
    /// start of the whole chain) and always ends at the end of the whole
    /// chain — Roslyn's own <c>WhenNotNull</c> nesting means every level's
    /// span reaches through to the tail.
    /// </summary>
    /// <param name="hop">A null-conditional hop.</param>
    /// <returns>The hop's Roslyn-exact span.</returns>
    public static TextSpan HopSpan(SyntaxNode hop)
    {
        if (!IsNullConditionalHop(hop))
        {
            throw new ArgumentException(
                "HopSpan requires a null-conditional hop; a non-hop node yields a plausible but meaningless span.",
                nameof(hop));
        }

        ExpressionSyntax top = ChainTop(hop);
        (int start, _) = ReceiverBounds(hop, top);
        return TextSpan.FromBounds(start, top.Span.End);
    }

    /// <summary>
    /// The Roslyn-exact span of <paramref name="hop"/>'s corresponding
    /// <c>ConditionalAccessExpressionSyntax.Expression</c>: for the first
    /// hop, its own natural receiver span; for a later hop, the span
    /// starting right after the previous hop's <c>?</c> and ending right
    /// before this hop's own <c>?</c> — Roslyn's receiverless binding shape,
    /// with no leading <c>?</c> of its own.
    /// </summary>
    /// <param name="hop">A null-conditional hop.</param>
    /// <returns>The hop's Roslyn-exact receiver span.</returns>
    public static TextSpan ReceiverSpan(SyntaxNode hop)
    {
        if (!IsNullConditionalHop(hop))
        {
            throw new ArgumentException(
                "ReceiverSpan requires a null-conditional hop; a non-hop node yields a plausible but meaningless span.",
                nameof(hop));
        }

        ExpressionSyntax top = ChainTop(hop);
        (int start, _) = ReceiverBounds(hop, top);
        return TextSpan.FromBounds(start, NullConditionalTokenStart(hop));
    }

    /// <summary>
    /// The Roslyn-exact span of <paramref name="hop"/>'s corresponding
    /// <c>ConditionalAccessExpressionSyntax.WhenNotNull</c>: right after this
    /// hop's own <c>?</c> through the end of the whole chain.
    /// </summary>
    /// <param name="hop">A null-conditional hop.</param>
    /// <returns>The hop's Roslyn-exact <c>WhenNotNull</c> span.</returns>
    public static TextSpan WhenNotNullSpan(SyntaxNode hop)
    {
        ExpressionSyntax top = ChainTop(hop);
        return TextSpan.FromBounds(NullConditionalTokenStart(hop) + 1, top.Span.End);
    }

    /// <summary>
    /// The G# token spelling <paramref name="hop"/>'s null-conditional
    /// operator — <c>?.</c> or <c>?[</c>, a single fused token, wider than
    /// Roslyn's bare <c>?</c> <c>OperatorToken</c>.
    /// </summary>
    /// <param name="hop">A null-conditional hop.</param>
    /// <returns>The <c>?.</c>/<c>?[</c> token.</returns>
    public static SyntaxToken NullConditionalOperatorToken(SyntaxNode hop) => hop switch
    {
        AccessorExpressionSyntax accessor => accessor.DotToken,
        IndexExpressionSyntax index => index.OpenBracketToken,
        _ => throw new ArgumentException("Node is not a null-conditional hop.", nameof(hop)),
    };

    /// <summary>
    /// The shared start-of-span computation for <see cref="HopSpan(SyntaxNode)"/>
    /// and <see cref="ReceiverSpan(SyntaxNode)"/>: the first hop in the chain
    /// keeps its natural start; every later hop starts right after the
    /// PREVIOUS hop's own <c>?</c>, skipping the character that belongs to
    /// the enclosing operator rather than to this receiverless position.
    /// </summary>
    private static (int Start, int End) ReceiverBounds(SyntaxNode hop, ExpressionSyntax top)
    {
        IReadOnlyList<ExpressionSyntax> hops = HopsInChain(top);
        int index = IndexOfHop(hops, hop);
        int start = index <= 0 ? top.Span.Start : NullConditionalTokenStart(hops[index - 1]) + 1;
        return (start, top.Span.End);
    }

    /// <summary>
    /// Every null-conditional hop reachable from <paramref name="chainTop"/>
    /// through chain links only (never into index arguments or call
    /// arguments, which start their own, unrelated sub-chains), ordered by
    /// source position — Roslyn's left-to-right <c>?.</c>/<c>?[</c>
    /// numbering, independent of which way any individual link nests.
    /// </summary>
    private static IReadOnlyList<ExpressionSyntax> HopsInChain(SyntaxNode chainTop)
    {
        var descendants = new List<SyntaxNode>();
        CollectChainDescendants(chainTop, descendants);

        var hops = new List<ExpressionSyntax>();
        foreach (SyntaxNode candidate in descendants)
        {
            if (IsNullConditionalHop(candidate))
            {
                hops.Add((ExpressionSyntax)candidate);
            }
        }

        hops.Sort((left, right) => NullConditionalTokenStart(left).CompareTo(NullConditionalTokenStart(right)));
        return hops;
    }

    private static void CollectChainDescendants(SyntaxNode node, List<SyntaxNode> into)
    {
        into.Add(node);
        switch (node)
        {
            case AccessorExpressionSyntax accessor:
                CollectChainDescendants(accessor.LeftPart, into);
                CollectChainDescendants(accessor.RightPart, into);
                break;
            case IndexExpressionSyntax index:
                CollectChainDescendants(index.Target, into);
                break;
            case CallExpressionSyntax call when call.Callee != null:
                CollectChainDescendants(call.Callee, into);
                break;
        }
    }

    private static int IndexOfHop(IReadOnlyList<ExpressionSyntax> hops, SyntaxNode hop)
    {
        for (int i = 0; i < hops.Count; i++)
        {
            if (ReferenceEquals(hops[i], hop))
            {
                return i;
            }
        }

        return -1;
    }

    private static int NullConditionalTokenStart(SyntaxNode hop) => hop switch
    {
        AccessorExpressionSyntax accessor => accessor.DotToken.Span.Start,
        IndexExpressionSyntax index => index.OpenBracketToken.Span.Start,
        _ => throw new ArgumentException("Node is not a null-conditional hop.", nameof(hop)),
    };

    /// <summary>
    /// True when <paramref name="node"/> sits in a LEFT-nesting chain
    /// position — the receiver-so-far of an ordinary iterative postfix step
    /// (<c>Accessor.LeftPart</c>, <c>Index.Target</c>, <c>Call.Callee</c>).
    /// Excludes <c>Accessor.RightPart</c> on purpose: being the right-hand
    /// side of a dot means a dot REACHED this node, not that anything
    /// follows it.
    /// </summary>
    private static bool IsInLeftNestingPosition(SyntaxNode node) => node.Parent switch
    {
        AccessorExpressionSyntax parent => ReferenceEquals(parent.LeftPart, node),
        IndexExpressionSyntax parent => ReferenceEquals(parent.Target, node),
        CallExpressionSyntax parent => parent.Callee != null && ReferenceEquals(parent.Callee, node),
        _ => false,
    };

    /// <summary>
    /// The parent node that extends the SAME postfix chain <paramref name="node"/>
    /// participates in, whichever way that particular link nests
    /// (<c>Accessor.LeftPart</c> OR <c>.RightPart</c>, <c>Index.Target</c>,
    /// <c>Call.Callee</c>), plus the totality case: <c>-&gt;</c> desugars
    /// <c>p-&gt;m</c> into <c>Accessor(Unary(*, p), arrowToken, m)</c>, so a
    /// node just before an arrow has its real chain-extending parent TWO
    /// levels up, past the synthesized dereference. Reachable from a real
    /// <c>?.</c> chain (<c>a?.b-&gt;m</c>) even though no C#-sourced analyzer
    /// can produce it (<c>-&gt;</c> is a G#-only construct).
    /// </summary>
    private static bool TryGetChainExtendingParent(SyntaxNode node, out SyntaxNode? parent)
    {
        switch (node.Parent)
        {
            case AccessorExpressionSyntax accessor when ReferenceEquals(accessor.LeftPart, node) || ReferenceEquals(accessor.RightPart, node):
                parent = accessor;
                return true;
            case IndexExpressionSyntax index when ReferenceEquals(index.Target, node):
                parent = index;
                return true;
            case CallExpressionSyntax call when call.Callee != null && ReferenceEquals(call.Callee, node):
                parent = call;
                return true;
            case UnaryExpressionSyntax deref
                when deref.OperatorToken.Kind == SyntaxKind.StarToken
                    && ReferenceEquals(deref.Operand, node)
                    && deref.Parent is AccessorExpressionSyntax outer
                    && ReferenceEquals(outer.LeftPart, deref):
                parent = outer;
                return true;
            default:
                parent = null;
                return false;
        }
    }
}
