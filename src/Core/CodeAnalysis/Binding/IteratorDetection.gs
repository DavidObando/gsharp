// <copyright file="IteratorDetection.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Syntax

/// Detects whether a function body is an iterator body.
shared class IteratorDetection {
    /// Returns whether [`body`](paramref) contains a yield in its own
    /// lexical scope. Nested function and lambda bodies are opaque.
    /// @param body The bound function body to inspect.
    /// @returns `true` when the body's own lexical scope contains a yield.
    func ContainsYield(body BoundStatement) bool {
        return BodyFacts.ContainsYield(body)
    }

    /// Returns whether [`body`](paramref) contains a yield in its own
    /// lexical scope. Nested function and lambda bodies are opaque.
    /// @param body The function body syntax to inspect.
    /// @returns `true` when the body's own lexical scope contains a yield.
    func ContainsYield(body SyntaxNode) bool -> ContainsYieldSyntax(body)

    internal func ContainsActiveYield(body SyntaxNode, activeCode ConditionalCompilationMap) bool ->
    ContainsYieldSyntax(body, activeCode)

    private func ContainsYieldSyntax(node SyntaxNode?, activeCode ConditionalCompilationMap? = nil) bool {
        if node == nil || activeCode?.IsActive(node) == false {
            return false
        }
        for child in node.GetChildren() {
            if activeCode?.IsActive(child) == false {
                continue
            }
            if child is YieldStatementSyntax {
                return true
            }
            if (child is FunctionDeclarationSyntax or FunctionLiteralExpressionSyntax or LambdaExpressionSyntax) {
                continue
            }
            if ContainsYieldSyntax(child, activeCode) {
                return true
            }
        }
        return false
    }
}
