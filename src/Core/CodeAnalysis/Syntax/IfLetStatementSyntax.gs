// <copyright file="IfLetStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents an `if let name = expr [, let n2 = e2]* { body } [else { else }]`
/// statement (ADR-0071 / issue #708). The binder lowers this shape into
/// existing if / declaration / block bound nodes; no new bound-node kind is
/// introduced.
class IfLetStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:IfLetStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param ifKeyword The `if` keyword token.
    /// @param bindings The comma-separated list of `let` bindings.
    /// @param thenStatement The then-block.
    /// @param elseClause The optional else clause.
    init(
        syntaxTree SyntaxTree,
        ifKeyword SyntaxToken,
        bindings SeparatedSyntaxList[IfLetBindingClauseSyntax],
        thenStatement StatementSyntax,
        elseClause ElseClauseSyntax?
    ) : base(syntaxTree) {
        IfKeyword = ifKeyword
        Bindings = bindings
        ThenStatement = thenStatement
        ElseClause = elseClause
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.IfLetStatement

    /// Gets the `if` keyword token.
    prop IfKeyword SyntaxToken {
        get;
    }

    /// Gets the comma-separated list of bindings.
    prop Bindings SeparatedSyntaxList[IfLetBindingClauseSyntax] {
        get;
    }

    /// Gets the then-statement (a block).
    prop ThenStatement StatementSyntax {
        get;
    }

    /// Gets the optional else clause; `null` when absent.
    prop ElseClause ElseClauseSyntax? {
        get;
    }
}
