// <copyright file="FallthroughStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Issue #3501 A3: the `fallthrough` statement (Go semantics). Legal
/// only as the last statement of a non-final `switch` arm body;
/// transfers control to the NEXT arm's body without evaluating that arm's
/// pattern or guard. The binder enforces placement (GS0168 family) — the
/// parser accepts the reserved keyword anywhere a statement can start.
class FallthroughStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:FallthroughStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param keyword The `fallthrough` keyword token.
    init(syntaxTree SyntaxTree, keyword SyntaxToken) : base(syntaxTree) {
        Keyword = keyword
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.FallthroughStatement

    /// Gets the `fallthrough` keyword token.
    prop Keyword SyntaxToken {
        get;
    }
}
