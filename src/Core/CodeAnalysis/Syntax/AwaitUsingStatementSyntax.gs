// <copyright file="AwaitUsingStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents an `await using let name = expr` declaration whose
/// bound variable is asynchronously disposed (via
/// `IAsyncDisposable.DisposeAsync`) when the enclosing scope exits. The
/// name may be the repeatable discard `_` (ADR-0168).
partial class AwaitUsingStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:AwaitUsingStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param awaitKeyword The `await` keyword.
    /// @param usingKeyword The `using` keyword.
    /// @param declaration The wrapped variable declaration.
    init(
        syntaxTree SyntaxTree,
        awaitKeyword SyntaxToken,
        usingKeyword SyntaxToken,
        declaration VariableDeclarationSyntax
    ) : base(syntaxTree) {
        AwaitKeyword = awaitKeyword
        UsingKeyword = usingKeyword
        Declaration = declaration
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.AwaitUsingStatement

    /// Gets the `await` keyword.
    prop AwaitKeyword SyntaxToken {
        get;
    }

    /// Gets the `using` keyword.
    prop UsingKeyword SyntaxToken {
        get;
    }

    /// Gets the wrapped variable declaration.
    prop Declaration VariableDeclarationSyntax {
        get;
    }
}
