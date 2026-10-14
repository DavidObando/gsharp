// <copyright file="BoundNode.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.CodeDom.Compiler
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.IO

/// Abstract base for a bound node.
abstract class BoundNode {
    private var childNodes ImmutableArray[BoundNode]

    /// Initializes a new instance of the (cref:BoundNode) class.
    /// @param syntax The originating (cref:SyntaxNode) this bound node was produced from, or
    /// `null` when the node was synthesised by a lowering pass and has no direct
    /// source counterpart (in which case the emitter will anchor a hidden
    /// `0xfeefee` sequence point on it).
    protected init(syntax SyntaxNode?) {
        Syntax = syntax
    }

    /// Gets the kind of bound node for this instance.
    abstract prop Kind BoundNodeKind {
        get;
    }

    /// Gets the originating (cref:SyntaxNode), or `null` when this node was
    /// synthesised by a lowering pass and has no direct source counterpart.
    /// On the pre-lowering (cref:BoundProgram) the binder guarantees an
    /// anchor on every statement, expression, and pattern (ADR-0169): nodes the
    /// construction site did not anchor are stamped by the bind dispatchers
    /// and, failing that, inherit the nearest anchored ancestor's syntax.
    prop Syntax SyntaxNode? {
        get;
        private set;
    }

    /// Gets this node's immediate child statements, expressions and patterns,
    /// in the order (cref:BoundTreeWalker) visits them — the Roslyn
    /// `IOperation.ChildOperations` analogue (ADR-0169, issue #4436).
    /// Helper nodes that are not themselves statements, expressions or
    /// patterns (a switch arm, a catch clause) are transparent: their own
    /// children are listed in their place. Three shapes follow Roslyn's
    /// operation tree rather than the compiler walker:
    /// - a function literal's child is its body, as an `IAnonymousFunctionOperation`'s is (the walker
    /// treats the body as a separate scope and does not enter it);
    /// - an assignment's children are its target, then its value;
    /// - a plain `x is T` has only its operand as a child, as an `IIsTypeOperation` does; the type pattern
    /// G# binds under it is not listed.
    prop ChildNodes ImmutableArray[BoundNode] {
        get {
            // A bound tree does not change once built, so each node's one-level
            // list is built once. Across a tree that is one entry per node, the
            // size of the tree itself.
            if childNodes.IsDefault {
                let collector = NodeCollector(this)
                collector.Visit(this)
                // The builder is not reused, so its contents move without a copy.
                ImmutableInterlocked.InterlockedInitialize(&childNodes, collector.Nodes.DrainToImmutable())
            }
            return childNodes
        }
    }

    /// Enumerates every node below this one, depth first — the Roslyn
    /// `OperationExtensions.Descendants()` analogue.
    /// @returns The descendants, excluding this node.
    func Descendants() sequence[BoundNode] {
        // Lazy and pre-order, like Roslyn's: it walks the cached ChildNodes
        // lists, so a partial enumeration stops early and nothing retains a
        // copy of the subtree.
        let pending = Stack[BoundNode]()
        PushChildren(pending, this)
        while pending.Count > 0 {
            let current = pending.Pop()
            yield current
            PushChildren(pending, current)
        }
    }

    /// Enumerates this node and every node below it, depth first — the Roslyn
    /// `OperationExtensions.DescendantsAndSelf()` analogue.
    /// @returns This node, then its descendants.
    func DescendantsAndSelf() sequence[BoundNode] {
        yield this
        for descendant in Descendants() {
            yield descendant
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    open override func ToString() string {
        {
            using let writer = StringWriter()
            BoundNodePrinter.WriteTo(this, writer)
            return writer.ToString()
        }
    }

    /// The syntax of the first node, in pre-order, that has one. Stops at the
    /// first hit rather than listing the subtree.
    /// @returns The first anchored syntax, or null.
    internal func FirstAnchoredSyntax() SyntaxNode? {
        if Syntax is {} own {
            return own
        }
        let finder = FirstSyntaxFinder()
        finder.Visit(this)
        return finder.Found
    }

    /// Anchors this node to [`syntax`](paramref) if it has no anchor yet.
    /// Idempotent by construction — an existing anchor is never replaced — so
    /// re-binding or body-cache reuse cannot change an observed location.
    /// @param syntax The syntax to anchor to.
    internal func AnchorSyntax(syntax SyntaxNode?) {
        if Syntax == nil && syntax != nil {
            Syntax = syntax
        }
    }

    private class FirstSyntaxFinder : BoundTreeWalker {
        prop Found SyntaxNode? {
            get;
            private set;
        }

        override func VisitStatement(node BoundStatement?) {
            if Look(node) {
                base.VisitStatement(node)
            }
        }

        override func VisitExpression(node BoundExpression?) {
            if Look(node) {
                base.VisitExpression(node)
            }
        }

        override func VisitPattern(node BoundPattern?) {
            if Look(node) {
                base.VisitPattern(node)
            }
        }

        // Whether to keep descending: false once anything has been found.
        private func Look(node BoundNode?) bool {
            if Found != nil || node == nil {
                return false
            }
            Found = node.Syntax
            return Found == nil
        }
    }

    /// Records the statements, expressions and patterns one level below a
    /// root, in the order the default walker visits them, with the
    /// operation-tree overrides described on (cref:ChildNodes).
    private class NodeCollector : BoundTreeWalker {
        private let root BoundNode

        init(root BoundNode) {
            Nodes = ImmutableArray.CreateBuilder[BoundNode]()
            this.root = root
        }

        prop Nodes ImmutableArray[BoundNode].Builder {
            get;
        }

        override func VisitStatement(node BoundStatement?) {
            if Take(node) {
                base.VisitStatement(node)
            }
        }

        override func VisitExpression(node BoundExpression?) {
            if !Take(node) {
                return
            }
            // The walker leaves a function literal opaque; the operation tree
            // does not. Only the literal itself (the root) lists its body: a
            // literal met as a child was recorded by Take and not entered, so
            // its body never becomes a sibling in its parent's list.
            if node is BoundFunctionLiteralExpression literal {
                VisitStatement(literal.Body)
                return
            }
            base.VisitExpression(node)
        }

        override func VisitPattern(node BoundPattern?) {
            if Take(node) {
                base.VisitPattern(node)
            }
        }

        protected override func VisitAssignmentExpression(node BoundAssignmentExpression) {
            VisitExpression(node.Target)
            VisitExpression(node.Value)
        }

        protected override func VisitIsExpression(node BoundIsExpression) {
            if node.IsSimpleTypeTest {
                VisitExpression(node.Expression)
                return
            }
            base.VisitIsExpression(node)
        }

        // Whether the base walker descends into the node: only the root. Any
        // other node is recorded as a child and not entered.
        private func Take(node BoundNode?) bool {
            if node == nil {
                return false
            }
            if object.ReferenceEquals(node, root) {
                return true
            }
            Nodes.Add(node)
            return false
        }
    }

    shared {
        private func PushChildren(pending Stack[BoundNode], node BoundNode) {
            let children = node.ChildNodes
            for var i = children.Length - 1; i >= 0; i-- {
                pending.Push(children[i])
            }
        }
    }
}
