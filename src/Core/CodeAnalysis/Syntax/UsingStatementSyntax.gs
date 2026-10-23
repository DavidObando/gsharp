// <copyright file="UsingStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a `using let name = expr` or
/// `using var name = expr` declaration whose bound variable is
/// disposed (via `IDisposable.Dispose`) when the enclosing scope
/// exits. The name may be the repeatable discard `_` (ADR-0168).
partial class UsingStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:UsingStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param usingKeyword The `using` keyword.
    /// @param declaration The wrapped variable declaration.
    init(syntaxTree SyntaxTree, usingKeyword SyntaxToken, declaration VariableDeclarationSyntax) : base(syntaxTree) {
        UsingKeyword = usingKeyword
        Declaration = declaration
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.UsingStatement

    /// Gets the `using` keyword.
    prop UsingKeyword SyntaxToken {
        get;
    }

    /// Gets the wrapped variable declaration.
    prop Declaration VariableDeclarationSyntax {
        get;
    }
}
