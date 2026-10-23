// <copyright file="ScopeStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a `scope { … }` structured-concurrency block
/// (Phase 5.7 / ADR-0022). All `go` statements lexically inside
/// the body register their tasks with the scope; the scope awaits all
/// of them on exit and propagates the first failure.
partial class ScopeStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:ScopeStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param scopeKeyword The `scope` keyword.
    /// @param body The body block.
    init(syntaxTree SyntaxTree, scopeKeyword SyntaxToken, body BlockStatementSyntax) : base(syntaxTree) {
        ScopeKeyword = scopeKeyword
        Body = body
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.ScopeStatement

    /// Gets the `scope` keyword.
    prop ScopeKeyword SyntaxToken {
        get;
    }

    /// Gets the body block.
    prop Body BlockStatementSyntax {
        get;
    }
}
