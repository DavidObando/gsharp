// <copyright file="LabeledStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a labeled statement of the form `name: statement`
/// (ADR-0070, extended by issue #1884). A label on a loop statement names it
/// for `break`/`continue` (ADR-0070); a label on any other
/// statement is a `goto` target (issue #1884). A duplicate label name
/// within the same enclosing function is reported as GS0470.
partial class LabeledStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:LabeledStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param labelIdentifier The label identifier token.
    /// @param colonToken The colon following the label.
    /// @param statement The labeled statement (expected to be a loop).
    init(syntaxTree SyntaxTree, labelIdentifier SyntaxToken, colonToken SyntaxToken, statement StatementSyntax) : base(
        syntaxTree
    ) {
        LabelIdentifier = labelIdentifier
        ColonToken = colonToken
        Statement = statement
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.LabeledStatement

    /// Gets the label identifier token.
    prop LabelIdentifier SyntaxToken {
        get;
    }

    /// Gets the colon token.
    prop ColonToken SyntaxToken {
        get;
    }

    /// Gets the inner statement carrying the label.
    prop Statement StatementSyntax {
        get;
    }
}
