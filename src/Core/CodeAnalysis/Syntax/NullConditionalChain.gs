// <copyright file="NullConditionalChain.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic

/// Structural helpers over a G# null-conditional access chain (`?.` /
/// `?[`), written for a migrated Roslyn analyzer (issue #4173) that used
/// to walk Roslyn's `ConditionalAccessExpressionSyntax` /
/// `MemberBindingExpressionSyntax` / `ElementBindingExpressionSyntax`
/// shapes and needs the G# equivalent at analysis time.
///
/// <b>Shape.</b> G# gives `a?.b` and `a.b` the SAME node
/// ((cref:AccessorExpressionSyntax)), told apart only by
/// (cref:AccessorExpressionSyntax.IsNullConditional); `a?[i]` is
/// (cref:IndexExpressionSyntax) with its own
/// (cref:IndexExpressionSyntax.IsNullConditional). A "hop" below always
/// means one such flagged node — the G# counterpart of one Roslyn
/// `ConditionalAccessExpressionSyntax` (one `?.`/`?[`
/// operator).
///
/// <b>Nesting is NOT a mirror image of Roslyn's, and it is not uniform.</b>
/// An earlier draft of this file assumed G#'s postfix chain nests via
/// `LeftPart` the way a naive left-to-right reading of
/// `Parser.Expressions.cs`'s `current = new X(current, …)` pattern
/// suggests. Empirically that is wrong for `.`/`?.`: parsing the
/// right-hand side of a dot recurses back into the full postfix grammar
/// (`ParseMemberContinuation` → `ParseNameOrCallExpression` → its
/// own `ParsePostfixChain`) BEFORE the enclosing loop iteration
/// finishes, so that recursive call already swallows every following
/// `.`/`?.`/`[`/`(`. The result is that a dotted chain
/// nests through (cref:AccessorExpressionSyntax.RightPart) — right/
/// suffix-nested, exactly like Roslyn's own
/// `ConditionalAccessExpressionSyntax.WhenNotNull` chain — while
/// `[`/`?[`/`(` continuations still nest the ordinary
/// iterative way, through (cref:IndexExpressionSyntax.Target) /
/// (cref:Syntax.CallExpressionSyntax.Callee) (left-nested, the
/// receiver-so-far). (cref:AssignmentTargetSyntaxFacts.TryLiftTrailingMemberAccess(ExpressionSyntax,
/// out ExpressionSyntax, out SyntaxToken, out SyntaxToken))
/// already relies on this same right-nesting for member-access chains and is
/// a second, independent confirmation.
///
/// Because of that split, "does node `n` have a further hop wrapping
/// it" is not one simple parent check: an inner `.`/`?.` hop is a
/// DESCENDANT of the chain's outer node (reached via `RightPart`), not
/// an ancestor. Every method here is built on two primitives that stay
/// correct regardless of which way a given link nests:
/// (cref:ChainTop(SyntaxNode)) (walk up through every kind of chain
/// link to the outermost node) and an internal left-to-right token-order
/// scan of the hops underneath that top (rather than a literal parent/child
/// walk) for "next hop" queries.
shared class NullConditionalChain {
    /// True when [`node`](paramref) is one null-conditional operator —
    /// the G# counterpart of one Roslyn `ConditionalAccessExpressionSyntax`.
    /// @param node The candidate node.
    /// @returns True for an (cref:AccessorExpressionSyntax) or (cref:IndexExpressionSyntax) with
    /// `IsNullConditional` set.
    func IsNullConditionalHop(node SyntaxNode?) bool -> switch node {
        case accessorExpressionSyntax is AccessorExpressionSyntax when accessorExpressionSyntax.IsNullConditional == true: true
        case indexExpressionSyntax is IndexExpressionSyntax when indexExpressionSyntax.IsNullConditional == true: true
        default: false
    }

    /// [`node`](paramref) as a null-conditional hop, or `null`
    /// when it is not one. The G# counterpart of Roslyn's
    /// `expr is ConditionalAccessExpressionSyntax x` type test — it
    /// matches `?.` AND `?[` uniformly, where the naive
    /// `AccessorExpressionSyntax {'{'} IsNullConditional: true {'}'}`
    /// pattern alone under-matches `a?[i]`.
    /// @param node The candidate node.
    /// @returns The node as an (cref:ExpressionSyntax) hop, or null.
    func AsNullConditionalHop(node SyntaxNode?) ExpressionSyntax? -> if IsNullConditionalHop(node) {
        cast[ExpressionSyntax](node!!)
    } else {
        default(ExpressionSyntax?)
    }

    /// The immediate receiver of one hop ((cref:AccessorExpressionSyntax.LeftPart)
    /// / (cref:IndexExpressionSyntax.Target)) — the G# counterpart of
    /// Roslyn's `ConditionalAccessExpressionSyntax.Expression`.
    ///
    /// Exact only for the FIRST hop of a chain (there, it is the genuine,
    /// independently-evaluated receiver — see
    /// `ExpressionBinder.Access.Accessor.cs`'s
    /// `BindNullConditionalAccessExpression`, which binds
    /// `syntax.LeftPart` as a standalone expression). For a LATER hop in
    /// the same chain, G# reuses the same `LeftPart` slot to hold just
    /// the next member NAME (the binder threads the real receiver value
    /// through a synthetic capture instead, with no syntax node of its own)
    /// — value-equivalent to what Roslyn's receiverless
    /// `MemberBindingExpressionSyntax`/`ElementBindingExpressionSyntax`
    /// denotes there, but not extent- or lifted-type-exact. Callers that
    /// read a LOCATION off this (I3a) get the Roslyn-exact span from
    /// (cref:ReceiverSpan(SyntaxNode)) instead.
    /// @param hop A null-conditional hop.
    /// @returns The hop's receiver expression.
    func NullConditionalReceiver(hop SyntaxNode) ExpressionSyntax -> switch hop {
        case accessor is AccessorExpressionSyntax: accessor.LeftPart
        case index is IndexExpressionSyntax: index.Target
        default: throw ArgumentException("Node is not a null-conditional hop.", "hop")
    }

    /// True when [`node`](paramref) sits at the outermost position of
    /// its postfix chain — nothing (`.`/`?.`/`[`/`?[`/`(`,
    /// or a synthesized `->` dereference) wraps it further.
    /// @param node The candidate node.
    /// @returns True when there is no chain-extending parent.
    func IsChainRoot(node SyntaxNode) bool -> !TryGetChainExtendingParent(node, out _)

    /// Walks chain-extending parents to the outermost node of the whole
    /// postfix chain [`node`](paramref) participates in.
    /// @param node Any node inside a postfix chain.
    /// @returns The chain's outermost expression.
    func ChainTop(node SyntaxNode) ExpressionSyntax {
        var current = node
        while TryGetChainExtendingParent(current, out var parent) {
            // Every branch of TryGetChainExtendingParent that returns true also
            // assigns a non-null node to `parent` first; only the false-returning
            // default branch leaves it null. The method just isn't annotated
            // [NotNullWhen(true)], so the compiler can't see that across the call.
            current = parent!!
        }
        return cast[ExpressionSyntax](current)
    }

    /// The next null-conditional hop reached after [`hop`](paramref)
    /// when the whole chain is read left to right — the G# counterpart of
    /// Roslyn's `WhenNotNull is ConditionalAccessExpressionSyntax` (a
    /// further `?.`/`?[` later in the same chain, possibly past
    /// intervening ordinary `.`/`[` steps). Because G#'s dotted
    /// continuations nest through `RightPart` (a later operator is a
    /// DESCENDANT, not an ancestor — see the type-level remarks), this is a
    /// left-to-right scan of the chain's hops, not a parent walk.
    /// @param hop A null-conditional hop.
    /// @returns The next hop in source order, or null when [`hop`](paramref) is last.
    func NextNullConditionalHop(hop SyntaxNode) ExpressionSyntax? {
        let hops = HopsInChain(ChainTop(hop))
        let index = IndexOfHop(hops, hop)
        return if index >= 0 && index + 1 < hops.Count {
            hops[index + 1]
        } else {
            default(ExpressionSyntax?)
        }
    }

    /// True when [`hop`](paramref) is the LAST operator of its chain
    /// and ends directly in a plain member name — the G# counterpart of
    /// Roslyn's `WhenNotNull is MemberBindingExpressionSyntax`.
    /// @param hop A null-conditional hop.
    /// @returns True for a terminal `?.name` hop.
    func TailIsMemberBinding(hop SyntaxNode) bool -> hop is AccessorExpressionSyntax &&
        hop.IsNullConditional == true &&
        hop.RightPart is NameExpressionSyntax

    /// True when [`hop`](paramref) is the LAST operator of its chain
    /// and is an element access — the G# counterpart of Roslyn's
    /// `WhenNotNull is ElementBindingExpressionSyntax`.
    ///
    /// Unlike (cref:TailIsMemberBinding(SyntaxNode)) this cannot be
    /// read off [`hop`](paramref) alone: `[`/`?[` nests the
    /// ORDINARY (left/iterative) way, so a FURTHER step after an index hop
    /// shows up as that index sitting in a chain-extending PARENT's
    /// `LeftPart`/`Target`/`Callee` — being wrapped as a
    /// parent's `RightPart` does not disqualify it (that parent is
    /// simply the dot that reached this index, not a further step past it).
    /// @param hop A null-conditional hop.
    /// @returns True for a terminal `?[…]` hop.
    func TailIsElementBinding(hop SyntaxNode) bool -> hop is IndexExpressionSyntax &&
        hop.IsNullConditional == true &&
        !IsInLeftNestingPosition(hop)

    /// True when [`hop`](paramref)'s receiver is itself the PLAIN name
    /// half of an immediately preceding `?.` — the G# counterpart of
    /// Roslyn's `Expression is MemberBindingExpressionSyntax`. Because
    /// dotted continuations nest via `RightPart`, this is a check of
    /// [`hop`](paramref)'s PARENT (the dot that produced this hop's
    /// name), not of (cref:NullConditionalReceiver(SyntaxNode))'s
    /// shape.
    /// @param hop A null-conditional hop.
    /// @returns True when the hop continues directly off a preceding `?.` with no ordinary step in between.
    func ReceiverIsMemberBinding(hop SyntaxNode) bool -> hop.Parent is AccessorExpressionSyntax{
        IsNullConditional: true
    } parent &&
        object.ReferenceEquals(parent.RightPart, hop)

    /// True when [`hop`](paramref)'s receiver is itself the plain name
    /// half of an immediately preceding ORDINARY (non-null-conditional)
    /// `.` — the G# counterpart of Roslyn's `Expression is
    /// MemberAccessExpressionSyntax`.
    /// @param hop A null-conditional hop.
    /// @returns True when the hop continues directly off a preceding ordinary `.`.
    func ReceiverIsPlainMemberAccess(hop SyntaxNode) bool -> hop.Parent is AccessorExpressionSyntax{
        IsNullConditional: false
    } parent &&
        object.ReferenceEquals(parent.RightPart, hop)

    /// True when [`hop`](paramref)'s receiver is itself a
    /// null-conditional element-access hop — the G# counterpart of Roslyn's
    /// `Expression is ElementBindingExpressionSyntax`. Unlike the
    /// member-binding checks above, `[`/`?[` nests the ordinary
    /// (left/iterative) way, so a preceding index hop shows up directly as
    /// (cref:NullConditionalReceiver(SyntaxNode)), not as a parent.
    /// @param hop A null-conditional hop.
    /// @returns True when the hop continues directly off a preceding `?[…]`.
    func ReceiverIsElementBinding(hop SyntaxNode) bool -> (
        NullConditionalReceiver(hop) is IndexExpressionSyntax and {IsNullConditional: true}
    )

    /// The Roslyn-exact span of [`hop`](paramref)'s corresponding
    /// `ConditionalAccessExpressionSyntax`: it starts where the
    /// previous hop's `?` ends (or, for the first hop, at the natural
    /// start of the whole chain) and always ends at the end of the whole
    /// chain — Roslyn's own `WhenNotNull` nesting means every level's
    /// span reaches through to the tail.
    /// @param hop A null-conditional hop.
    /// @returns The hop's Roslyn-exact span.
    func HopSpan(hop SyntaxNode) TextSpan {
        if !IsNullConditionalHop(hop) {
            throw ArgumentException(
                "HopSpan requires a null-conditional hop; a non-hop node yields a plausible but meaningless span.",
                "hop"
            )
        }
        let top = ChainTop(hop)
        let (start, _) = ReceiverBounds(hop, top)
        return TextSpan.FromBounds(start, top.Span.End)
    }

    /// The Roslyn-exact span of [`hop`](paramref)'s corresponding
    /// `ConditionalAccessExpressionSyntax.Expression`: for the first
    /// hop, its own natural receiver span; for a later hop, the span
    /// starting right after the previous hop's `?` and ending right
    /// before this hop's own `?` — Roslyn's receiverless binding shape,
    /// with no leading `?` of its own.
    /// @param hop A null-conditional hop.
    /// @returns The hop's Roslyn-exact receiver span.
    func ReceiverSpan(hop SyntaxNode) TextSpan {
        if !IsNullConditionalHop(hop) {
            throw ArgumentException(
                "ReceiverSpan requires a null-conditional hop; a non-hop node yields a plausible but meaningless span.",
                "hop"
            )
        }
        let top = ChainTop(hop)
        let (start, _) = ReceiverBounds(hop, top)
        return TextSpan.FromBounds(start, NullConditionalTokenStart(hop))
    }

    /// The Roslyn-exact span of [`hop`](paramref)'s corresponding
    /// `ConditionalAccessExpressionSyntax.WhenNotNull`: right after this
    /// hop's own `?` through the end of the whole chain.
    /// @param hop A null-conditional hop.
    /// @returns The hop's Roslyn-exact `WhenNotNull` span.
    func WhenNotNullSpan(hop SyntaxNode) TextSpan {
        let top = ChainTop(hop)
        return TextSpan.FromBounds(NullConditionalTokenStart(hop) + 1, top.Span.End)
    }

    /// The G# token spelling [`hop`](paramref)'s null-conditional
    /// operator — `?.` or `?[`, a single fused token, wider than
    /// Roslyn's bare `?` `OperatorToken`.
    /// @param hop A null-conditional hop.
    /// @returns The `?.`/`?[` token.
    func NullConditionalOperatorToken(hop SyntaxNode) SyntaxToken -> switch hop {
        case accessor is AccessorExpressionSyntax: accessor.DotToken
        case index is IndexExpressionSyntax: index.OpenBracketToken
        default: throw ArgumentException("Node is not a null-conditional hop.", "hop")
    }

    /// The shared start-of-span computation for (cref:HopSpan(SyntaxNode))
    /// and (cref:ReceiverSpan(SyntaxNode)): the first hop in the chain
    /// keeps its natural start; every later hop starts right after the
    /// PREVIOUS hop's own `?`, skipping the character that belongs to
    /// the enclosing operator rather than to this receiverless position.
    private func ReceiverBounds(hop SyntaxNode, top ExpressionSyntax)(Start int32, End int32) {
        let hops = HopsInChain(top)
        let index = IndexOfHop(hops, hop)
        let start = if index <= 0 {
            top.Span.Start
        } else {
            NullConditionalTokenStart(hops[index - 1]) + 1
        }
        return (start, top.Span.End)
    }

    /// Every null-conditional hop reachable from [`chainTop`](paramref)
    /// through chain links only (never into index arguments or call
    /// arguments, which start their own, unrelated sub-chains), ordered by
    /// source position — Roslyn's left-to-right `?.`/`?[`
    /// numbering, independent of which way any individual link nests.
    private func HopsInChain(chainTop SyntaxNode) IReadOnlyList[ExpressionSyntax] {
        let descendants = List[SyntaxNode]()
        CollectChainDescendants(chainTop, descendants)
        let hops = List[ExpressionSyntax]()
        for candidate in descendants {
            if IsNullConditionalHop(candidate) {
                hops.Add(cast[ExpressionSyntax](candidate))
            }
        }
        hops.Sort(
            (left ExpressionSyntax, right ExpressionSyntax) -> NullConditionalTokenStart(left).CompareTo(
                NullConditionalTokenStart(right)
            )
        )
        return hops
    }

    private func CollectChainDescendants(node SyntaxNode, into List[SyntaxNode]) {
        into.Add(node)
        switch node {
            case accessor is AccessorExpressionSyntax {
                CollectChainDescendants(accessor.LeftPart, into)
                CollectChainDescendants(accessor.RightPart, into)
            }
            case index is IndexExpressionSyntax {
                CollectChainDescendants(index.Target, into)
            }
            case call is CallExpressionSyntax when call.Callee != nil {
                CollectChainDescendants(call.Callee!!, into)
            }
        }
    }

    private func IndexOfHop(hops IReadOnlyList[ExpressionSyntax], hop SyntaxNode) int32 {
        for var i = 0; i < hops.Count; i++ {
            if object.ReferenceEquals(hops[i], hop) {
                return i
            }
        }
        return -1
    }

    private func NullConditionalTokenStart(hop SyntaxNode) int32 -> switch hop {
        case accessor is AccessorExpressionSyntax: accessor.DotToken.Span.Start
        case index is IndexExpressionSyntax: index.OpenBracketToken.Span.Start
        default: throw ArgumentException("Node is not a null-conditional hop.", "hop")
    }

    /// True when [`node`](paramref) sits in a LEFT-nesting chain
    /// position — the receiver-so-far of an ordinary iterative postfix step
    /// (`Accessor.LeftPart`, `Index.Target`, `Call.Callee`).
    /// Excludes `Accessor.RightPart` on purpose: being the right-hand
    /// side of a dot means a dot REACHED this node, not that anything
    /// follows it.
    private func IsInLeftNestingPosition(node SyntaxNode) bool -> switch node.Parent {
        case parent is AccessorExpressionSyntax: object.ReferenceEquals(parent.LeftPart, node)
        case parent is IndexExpressionSyntax: object.ReferenceEquals(parent.Target, node)
        case parent is CallExpressionSyntax: parent.Callee != nil && object.ReferenceEquals(parent.Callee, node)
        default: false
    }

    /// The parent node that extends the SAME postfix chain [`node`](paramref)
    /// participates in, whichever way that particular link nests
    /// (`Accessor.LeftPart` OR `.RightPart`, `Index.Target`,
    /// `Call.Callee`), plus the totality case: `->` desugars
    /// `p->m` into `Accessor(Unary(*, p), arrowToken, m)`, so a
    /// node just before an arrow has its real chain-extending parent TWO
    /// levels up, past the synthesized dereference. Reachable from a real
    /// `?.` chain (`a?.b->m`) even though no C#-sourced analyzer
    /// can produce it (`->` is a G#-only construct).
    private func TryGetChainExtendingParent(node SyntaxNode, out parent SyntaxNode?) bool {
        switch node.Parent {
            case accessor is AccessorExpressionSyntax when object.ReferenceEquals(accessor.LeftPart, node) ||
                object.ReferenceEquals(accessor.RightPart, node) {
                parent = accessor
                return true
            }
            case index is IndexExpressionSyntax when object.ReferenceEquals(index.Target, node) {
                parent = index
                return true
            }
            case call is CallExpressionSyntax when call.Callee != nil && object.ReferenceEquals(call.Callee, node) {
                parent = call
                return true
            }
            case deref is UnaryExpressionSyntax when deref
                .OperatorToken
                .Kind == SyntaxKind.StarToken &&
                object.ReferenceEquals(deref.Operand, node) &&
                deref.Parent is AccessorExpressionSyntax outer &&
                object.ReferenceEquals(outer.LeftPart, deref) {
                parent = outer
                return true
            }
            default {
                parent = nil
                return false
            }
        }
    }
}
