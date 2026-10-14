// <copyright file="WhileLetStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a `while let name = expr [, let n2 = e2]* { body }`
/// statement (ADR-0163 / issue #3352).
/// @remarks Each initializer is re-evaluated before every iteration. The bindings are
/// visible only inside (cref:Body) and are observed there at their
/// underlying non-null types.
class WhileLetStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:WhileLetStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param whileKeyword The `while` keyword token.
    /// @param bindings The comma-separated `let` bindings.
    /// @param body The loop body.
    init(
        syntaxTree SyntaxTree,
        whileKeyword SyntaxToken,
        bindings SeparatedSyntaxList[IfLetBindingClauseSyntax],
        body StatementSyntax
    ) : base(syntaxTree) {
        WhileKeyword = whileKeyword
        Bindings = bindings
        Body = body
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.WhileLetStatement

    /// Gets the `while` keyword token.
    prop WhileKeyword SyntaxToken {
        get;
    }

    /// Gets the comma-separated binding list.
    prop Bindings SeparatedSyntaxList[IfLetBindingClauseSyntax] {
        get;
    }

    /// Gets the loop body.
    prop Body StatementSyntax {
        get;
    }
}
