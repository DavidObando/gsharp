// <copyright file="NotPatternSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a negated pattern such as `not > 0`. The `not`
/// operator is a contextual keyword matched as an identifier in pattern
/// position and binds more tightly than `and` / `or`.
class NotPatternSyntax : PatternSyntax {
    /// Initializes a new instance of the (cref:NotPatternSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param notKeyword The `not` contextual keyword token.
    /// @param pattern The negated sub-pattern.
    init(syntaxTree SyntaxTree, notKeyword SyntaxToken, pattern PatternSyntax) : base(syntaxTree) {
        NotKeyword = notKeyword
        Pattern = pattern
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.NotPattern

    /// Gets the `not` keyword token.
    prop NotKeyword SyntaxToken {
        get;
    }

    /// Gets the negated sub-pattern.
    prop Pattern PatternSyntax {
        get;
    }
}
