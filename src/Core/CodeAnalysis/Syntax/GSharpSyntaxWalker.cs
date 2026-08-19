// <copyright file="GSharpSyntaxWalker.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Depth-first syntax visitor that, by default, recurses into every child of
/// every node via <see cref="SyntaxNode.GetChildren"/>. Subclasses override
/// <see cref="Visit"/> or <see cref="DefaultVisit"/> to observe nodes of
/// interest; the analyzer framework's dispatch walker (ADR-0169) is built on
/// this, mirroring Roslyn's <c>CSharpSyntaxWalker</c>.
/// </summary>
public abstract class GSharpSyntaxWalker
{
    /// <summary>
    /// Visits a node. The default implementation forwards to
    /// <see cref="DefaultVisit"/>, which recurses into children.
    /// </summary>
    /// <param name="node">The node to visit. Null is a legitimate absent optional child and is ignored.</param>
    public virtual void Visit(SyntaxNode? node)
    {
        if (node is null)
        {
            return;
        }

        if (node is SyntaxToken token)
        {
            VisitToken(token);
            return;
        }

        DefaultVisit(node);
    }

    /// <summary>
    /// Visits a token. Tokens have no children; the default implementation
    /// does nothing.
    /// </summary>
    /// <param name="token">The token to visit.</param>
    public virtual void VisitToken(SyntaxToken token)
    {
    }

    /// <summary>
    /// Visits every child of <paramref name="node"/> in
    /// <see cref="SyntaxNode.GetChildren"/> order.
    /// </summary>
    /// <param name="node">The node whose children to visit.</param>
    protected virtual void DefaultVisit(SyntaxNode node)
    {
        foreach (var child in node.GetChildren())
        {
            Visit(child);
        }
    }
}
