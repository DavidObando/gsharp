// <copyright file="NamedDeconstructionStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents `let { Field = local, ... } = expr` data-struct deconstruction.
class NamedDeconstructionStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:NamedDeconstructionStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param keyword The `let` keyword.
    /// @param openBraceToken The opening brace.
    /// @param fields The named field bindings.
    /// @param closeBraceToken The closing brace.
    /// @param equalsToken The equals token before the initializer.
    /// @param initializer The initializer expression.
    init(
        syntaxTree SyntaxTree,
        keyword SyntaxToken,
        openBraceToken SyntaxToken,
        fields SeparatedSyntaxList[NamedDeconstructionFieldSyntax],
        closeBraceToken SyntaxToken,
        equalsToken SyntaxToken,
        initializer ExpressionSyntax
    ) : base(syntaxTree) {
        Keyword = keyword
        OpenBraceToken = openBraceToken
        Fields = fields
        CloseBraceToken = closeBraceToken
        EqualsToken = equalsToken
        Initializer = initializer
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.NamedDeconstructionStatement

    /// Gets the `let` keyword.
    prop Keyword SyntaxToken {
        get;
    }

    /// Gets the opening brace.
    prop OpenBraceToken SyntaxToken {
        get;
    }

    /// Gets the named field bindings.
    prop Fields SeparatedSyntaxList[NamedDeconstructionFieldSyntax] {
        get;
    }

    /// Gets the closing brace.
    prop CloseBraceToken SyntaxToken {
        get;
    }

    /// Gets the equals token before the initializer.
    prop EqualsToken SyntaxToken {
        get;
    }

    /// Gets the initializer expression.
    prop Initializer ExpressionSyntax {
        get;
    }
}
