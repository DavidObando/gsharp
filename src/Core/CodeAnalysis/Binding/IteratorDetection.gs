// <copyright file="IteratorDetection.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Syntax

/// Detects whether a function body is an iterator body.
shared class IteratorDetection {
    private class BoundYieldDetector : BoundTreeWalker {
        prop Found bool {
            get;
            private set;
        }

        protected override func VisitYieldStatement(node BoundYieldStatement) {
            Found = true
        }
    }

    /// Returns whether [`body`](paramref) contains a yield in its own
    /// lexical scope. Nested function and lambda bodies are opaque.
    /// @param body The bound function body to inspect.
    /// @returns `true` when the body's own lexical scope contains a yield.
    func ContainsYield(body BoundStatement) bool {
        let detector = BoundYieldDetector()
        detector.Visit(body)
        return detector.Found
    }

    /// Returns whether [`body`](paramref) contains a yield in its own
    /// lexical scope. Nested function and lambda bodies are opaque.
    /// @param body The function body syntax to inspect.
    /// @returns `true` when the body's own lexical scope contains a yield.
    func ContainsYield(body SyntaxNode) bool -> ContainsYieldSyntax(body)

    private func ContainsYieldSyntax(node SyntaxNode?) bool {
        if node == nil {
            return false
        }
        for child in node.GetChildren() {
            if child is YieldStatementSyntax {
                return true
            }
            if (child is FunctionDeclarationSyntax or FunctionLiteralExpressionSyntax or LambdaExpressionSyntax) {
                continue
            }
            if ContainsYieldSyntax(child) {
                return true
            }
        }
        return false
    }
}
