// <copyright file="TryStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System.Collections.Immutable

/// Represents a `try { … } catch (e Exception) { … } finally { … }`
/// statement. Either at least one catch clause or a finally clause
/// must be present.
class TryStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:TryStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param tryKeyword The `try` keyword.
    /// @param tryBlock The protected block.
    /// @param catchClauses Zero or more catch clauses.
    /// @param finallyClause An optional finally clause.
    init(
        syntaxTree SyntaxTree,
        tryKeyword SyntaxToken,
        tryBlock BlockStatementSyntax,
        catchClauses ImmutableArray[CatchClauseSyntax],
        finallyClause FinallyClauseSyntax?
    ) : base(syntaxTree) {
        TryKeyword = tryKeyword
        TryBlock = tryBlock
        CatchClauses = catchClauses
        FinallyClause = finallyClause
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.TryStatement

    /// Gets the `try` keyword.
    prop TryKeyword SyntaxToken {
        get;
    }

    /// Gets the protected block.
    prop TryBlock BlockStatementSyntax {
        get;
    }

    /// Gets the catch clauses.
    prop CatchClauses ImmutableArray[CatchClauseSyntax] {
        get;
    }

    /// Gets the optional finally clause.
    prop FinallyClause FinallyClauseSyntax? {
        get;
    }
}
