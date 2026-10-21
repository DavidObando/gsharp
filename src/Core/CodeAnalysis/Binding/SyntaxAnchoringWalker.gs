// <copyright file="SyntaxAnchoringWalker.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax

/// Fills the (cref:BoundNode.Syntax) anchor of every statement,
/// expression, and pattern that construction and the bind dispatchers left
/// unanchored, inheriting the nearest anchored ancestor's syntax (ADR-0169).
/// Runs once per member body at the end of `Binder.BindProgram`, so the
/// pre-lowering-visible (cref:BoundProgram) guarantees a non-null
/// anchor on every dispatchable node — synthesized lowering nodes report at
/// their enclosing construct, mirroring how the emitter anchors hidden
/// sequence points. Idempotent: an existing anchor is never replaced.
internal class SyntaxAnchoringWalker : BoundTreeWalker {
    private var anchor SyntaxNode?
    private var ownership BoundSourceOwnership.Collector?

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func VisitStatement(node BoundStatement?) -> VisitAnchored(node, base.VisitStatement)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func VisitExpression(node BoundExpression?) -> VisitAnchored(node, base.VisitExpression)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func VisitPattern(node BoundPattern?) -> VisitAnchored(node, base.VisitPattern)

    private func VisitAnchored[TNode BoundNode](node TNode?, visitBase(TNode?) -> void) {
        if node == nil {
            return
        }
        let saved = anchor
        if node.Syntax == nil {
            // BoundErrorExpression keeps its null anchor: null-vs-non-null
            // Syntax is the binder's defer-and-rebind sentinel, and cached
            // bodies may hold error nodes from partially-bound programs.
            if !(node is BoundErrorExpression) {
                node.AnchorSyntax(anchor)
            }
        } else {
            anchor = node.Syntax
        }
        ownership?.Record(node)
        visitBase(node)
        anchor = saved
    }

    shared {
        /// Anchors every node reachable from [`body`](paramref).
        /// @param body The bound body to anchor.
        /// @param fallbackAnchor The anchor used until a node with its own syntax is found (the member's
        /// declaration).
        func Anchor(body BoundNode?, fallbackAnchor SyntaxNode?) {
            if body == nil {
                return
            }
            let block = body as BoundBlockStatement
            block?.InvalidateSourceOwnership()
            let ownership = if block != nil && !(fallbackAnchor is FunctionDeclarationSyntax) {
                BoundSourceOwnership.Collector()
            } else {
                default(BoundSourceOwnership.Collector?)
            }
            SyntaxAnchoringWalker{anchor: fallbackAnchor, ownership: ownership}.Visit(body)
            if block != nil && ownership != nil {
                let facts = ownership.Complete()
                block.SetSourceOwnership(facts)
                CompilationMeasurements.Count("semantic.ownership.fact-roots.captured")
                CompilationMeasurements.Count("semantic.ownership.producer-record-visits", facts.RecordVisits)
            }
        }
    }
}
