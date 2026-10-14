// <copyright file="ElseClauseSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents the else clause syntax in the language.
class ElseClauseSyntax : SyntaxNode {
    /// Initializes a new instance of the (cref:ElseClauseSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param elseKeyword The else keyword.
    /// @param elseStatement The else statement.
    init(syntaxTree SyntaxTree, elseKeyword SyntaxToken, elseStatement StatementSyntax) : base(syntaxTree) {
        ElseKeyword = elseKeyword
        ElseStatement = elseStatement
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.ElseClause

    /// Gets the else keyword.
    prop ElseKeyword SyntaxToken {
        get;
    }

    /// Gets the else statement.
    prop ElseStatement StatementSyntax {
        get;
    }
}
