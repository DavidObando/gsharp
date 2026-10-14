// <copyright file="BinaryPatternSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a binary pattern combinator such as `> 0 and < 10`
/// (conjunction) or `< 0 or > 100` (disjunction). The operator is a
/// contextual keyword (`and` / `or`) matched as an identifier in
/// pattern position.
class BinaryPatternSyntax : PatternSyntax {
    /// Initializes a new instance of the (cref:BinaryPatternSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param left The left-hand sub-pattern.
    /// @param operatorToken The `and` / `or` contextual keyword token.
    /// @param right The right-hand sub-pattern.
    init(syntaxTree SyntaxTree, left PatternSyntax, operatorToken SyntaxToken, right PatternSyntax) : base(syntaxTree) {
        Left = left
        OperatorToken = operatorToken
        Right = right
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.BinaryPattern

    /// Gets the left-hand sub-pattern.
    prop Left PatternSyntax {
        get;
    }

    /// Gets the operator token (`and` or `or`).
    prop OperatorToken SyntaxToken {
        get;
    }

    /// Gets the right-hand sub-pattern.
    prop Right PatternSyntax {
        get;
    }
}
