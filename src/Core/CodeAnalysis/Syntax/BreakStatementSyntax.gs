// <copyright file="BreakStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents the break statement syntax in the language. An optional trailing
/// identifier (on the same source line) names an enclosing labeled loop
/// (ADR-0070).
open partial class BreakStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:BreakStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param keyword The break keyword.
    /// @param labelIdentifier Optional target label identifier (must appear on the same source line
    /// as the [`keyword`](paramref)); `null` for an
    /// innermost-loop break.
    init(syntaxTree SyntaxTree, keyword SyntaxToken, labelIdentifier SyntaxToken? = nil) : base(syntaxTree) {
        Keyword = keyword
        LabelIdentifier = labelIdentifier
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    open override prop Kind SyntaxKind -> SyntaxKind.BreakStatement

    /// Gets the break keyword.
    prop Keyword SyntaxToken {
        get;
    }

    /// Gets the optional target label identifier (`null` when
    /// the break targets the innermost enclosing loop).
    prop LabelIdentifier SyntaxToken? {
        get;
    }
}
