// <copyright file="GlobalStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a global statement in the language.
open class GlobalStatementSyntax : MemberSyntax {
    /// Initializes a new instance of the (cref:GlobalStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param statement The statements to include.
    init(syntaxTree SyntaxTree, statement StatementSyntax) : base(syntaxTree) {
        Statement = statement
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    open override prop Kind SyntaxKind -> SyntaxKind.GlobalStatement

    /// Gets the statements included in this global statement.
    prop Statement StatementSyntax {
        get;
    }
}
