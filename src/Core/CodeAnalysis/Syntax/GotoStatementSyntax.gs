// <copyright file="GotoStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a `goto label` statement (issue #1884): an unconditional
/// jump to a statement elsewhere in the enclosing function marked with
/// `label:` ((cref:LabeledStatementSyntax)).
class GotoStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:GotoStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param keyword The `goto` keyword.
    /// @param labelIdentifier The target label identifier.
    init(syntaxTree SyntaxTree, keyword SyntaxToken, labelIdentifier SyntaxToken) : base(syntaxTree) {
        Keyword = keyword
        LabelIdentifier = labelIdentifier
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.GotoStatement

    /// Gets the `goto` keyword.
    prop Keyword SyntaxToken {
        get;
    }

    /// Gets the target label identifier.
    prop LabelIdentifier SyntaxToken {
        get;
    }
}
