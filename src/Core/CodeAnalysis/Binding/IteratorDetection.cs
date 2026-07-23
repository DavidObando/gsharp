// <copyright file="IteratorDetection.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>Detects whether a function body is an iterator body.</summary>
public static class IteratorDetection
{
    /// <summary>
    /// Returns whether <paramref name="body"/> contains a yield in its own
    /// lexical scope. Nested function and lambda bodies are opaque.
    /// </summary>
    /// <param name="body">The bound function body to inspect.</param>
    /// <returns><see langword="true"/> when the body's own lexical scope contains a yield.</returns>
    public static bool ContainsYield(BoundStatement body)
    {
        var detector = new BoundYieldDetector();
        detector.Visit(body);
        return detector.Found;
    }

    /// <summary>
    /// Returns whether <paramref name="body"/> contains a yield in its own
    /// lexical scope. Nested function and lambda bodies are opaque.
    /// </summary>
    /// <param name="body">The function body syntax to inspect.</param>
    /// <returns><see langword="true"/> when the body's own lexical scope contains a yield.</returns>
    public static bool ContainsYield(SyntaxNode body) => ContainsYieldSyntax(body);

    private static bool ContainsYieldSyntax(SyntaxNode node)
    {
        if (node == null)
        {
            return false;
        }

        foreach (var child in node.GetChildren())
        {
            if (child is YieldStatementSyntax)
            {
                return true;
            }

            if (child is FunctionDeclarationSyntax
                or FunctionLiteralExpressionSyntax
                or LambdaExpressionSyntax)
            {
                continue;
            }

            if (ContainsYieldSyntax(child))
            {
                return true;
            }
        }

        return false;
    }

    private sealed class BoundYieldDetector : BoundTreeWalker
    {
        public bool Found { get; private set; }

        protected override void VisitYieldStatement(BoundYieldStatement node)
        {
            Found = true;
        }
    }
}
