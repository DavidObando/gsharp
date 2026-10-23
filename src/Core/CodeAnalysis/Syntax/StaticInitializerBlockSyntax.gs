// <copyright file="StaticInitializerBlockSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents an `init { … }` static-initializer block declared inside a
/// `shared { … }` block (ADR-0140 / issue #2131). Its statements run in the
/// containing type's `.cctor` (static constructor) after the static-field
/// initializers, matching a C# static constructor body.
partial class StaticInitializerBlockSyntax : SyntaxNode {
    /// Initializes a new instance of the (cref:StaticInitializerBlockSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param initKeyword The contextual `init` identifier token.
    /// @param body The block of statements executed in the type initializer.
    init(syntaxTree SyntaxTree, initKeyword SyntaxToken, body BlockStatementSyntax) : base(syntaxTree) {
        InitKeyword = initKeyword
        Body = body
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.StaticInitializerBlock

    /// Gets the contextual `init` identifier token.
    prop InitKeyword SyntaxToken {
        get;
    }

    /// Gets the block of statements executed in the type initializer.
    prop Body BlockStatementSyntax {
        get;
    }
}
