// <copyright file="SelectStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System.Collections.Immutable

/// Represents a `select { … }` statement that orchestrates one of
/// several channel send/receive operations (Phase 5.6 / ADR-0022).
partial class SelectStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:SelectStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param selectKeyword The `select` keyword.
    /// @param openBraceToken The opening brace.
    /// @param cases The arms (case + default).
    /// @param closeBraceToken The closing brace.
    init(
        syntaxTree SyntaxTree,
        selectKeyword SyntaxToken,
        openBraceToken SyntaxToken,
        cases ImmutableArray[SelectCaseSyntax],
        closeBraceToken SyntaxToken
    ) : base(syntaxTree) {
        SelectKeyword = selectKeyword
        OpenBraceToken = openBraceToken
        Cases = cases
        CloseBraceToken = closeBraceToken
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.SelectStatement

    /// Gets the `select` keyword.
    prop SelectKeyword SyntaxToken {
        get;
    }

    /// Gets the opening brace.
    prop OpenBraceToken SyntaxToken {
        get;
    }

    /// Gets the arms.
    prop Cases ImmutableArray[SelectCaseSyntax] {
        get;
    }

    /// Gets the closing brace.
    prop CloseBraceToken SyntaxToken {
        get;
    }
}
