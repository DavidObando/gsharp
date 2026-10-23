// <copyright file="GSharpSyntaxWalker.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Depth-first syntax visitor that, by default, recurses into every child of
/// every node via (cref:SyntaxNode.GetChildren). Subclasses override
/// (cref:Visit) or (cref:DefaultVisit) to observe nodes of
/// interest; the analyzer framework's dispatch walker (ADR-0169) is built on
/// this, mirroring Roslyn's `CSharpSyntaxWalker`.
abstract class GSharpSyntaxWalker {
    /// Visits a node. The default implementation forwards to
    /// (cref:DefaultVisit), which recurses into children.
    /// @param node The node to visit. Null is a legitimate absent optional child and is ignored.
    open func Visit(node SyntaxNode?) {
        if node == nil {
            return
        }
        if node is SyntaxToken token {
            VisitToken(token)
            return
        }
        DefaultVisit(node)
    }

    /// Visits a token. Tokens have no children; the default implementation
    /// does nothing.
    /// @param token The token to visit.
    open func VisitToken(token SyntaxToken) { }

    /// Visits every child of [`node`](paramref) in
    /// (cref:SyntaxNode.GetChildren) order.
    /// @param node The node whose children to visit.
    protected open func DefaultVisit(node SyntaxNode) {
        let count = node.ChildCount
        for var i = 0; i < count; i++ {
            Visit(node.GetChild(i))
        }
    }
}
