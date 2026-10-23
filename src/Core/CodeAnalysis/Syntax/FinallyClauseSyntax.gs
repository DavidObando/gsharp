// <copyright file="FinallyClauseSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a `finally { … }` clause attached to a
/// (cref:TryStatementSyntax).
partial class FinallyClauseSyntax : SyntaxNode {
    /// Initializes a new instance of the (cref:FinallyClauseSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param finallyKeyword The `finally` keyword.
    /// @param body The cleanup block.
    init(syntaxTree SyntaxTree, finallyKeyword SyntaxToken, body BlockStatementSyntax) : base(syntaxTree) {
        FinallyKeyword = finallyKeyword
        Body = body
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.FinallyClause

    /// Gets the `finally` keyword.
    prop FinallyKeyword SyntaxToken {
        get;
    }

    /// Gets the cleanup block.
    prop Body BlockStatementSyntax {
        get;
    }
}
