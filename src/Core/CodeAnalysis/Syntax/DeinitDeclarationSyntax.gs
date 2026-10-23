// <copyright file="DeinitDeclarationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Text

/// ADR-0068 / issue #698: represents a class-body destructor declared with
/// Swift-style syntax — `deinit { … }`. No name, no parameters, no
/// return type, no accessibility modifier. The emitter lowers each
/// (cref:DeinitDeclarationSyntax) to a CLR `Finalize` override
/// whose body is wrapped in `try { … } finally { base.Finalize(); }`.
/// Only valid inside a `class` body.
partial class DeinitDeclarationSyntax : MemberSyntax {
    /// Initializes a new instance of the (cref:DeinitDeclarationSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param deinitKeyword The contextual `deinit` keyword that introduces the destructor.
    /// @param body The destructor body block.
    init(syntaxTree SyntaxTree, deinitKeyword SyntaxToken, body BlockStatementSyntax) : base(syntaxTree) {
        DeinitKeyword = deinitKeyword
        Body = body
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.DeinitDeclaration

    /// Gets the contextual `deinit` keyword.
    prop DeinitKeyword SyntaxToken {
        get;
    }

    /// Gets the destructor body block.
    prop Body BlockStatementSyntax {
        get;
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Span TextSpan -> TextSpan.FromBounds(DeinitKeyword.Span.Start, Body.Span.End)
}
