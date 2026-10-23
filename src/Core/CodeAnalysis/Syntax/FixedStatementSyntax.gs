// <copyright file="FixedStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// ADR-0125 / issue #1026: a `fixed` (pinning) statement
/// `fixed name *T = source { … }`. It pins a managed array or string
/// `source` for the duration of the block and binds an unmanaged pointer
/// `*T` ((cref:TypeClause), only spellable inside an `unsafe`
/// context per ADR-0122) into the first element of the pinned buffer. The pin
/// is emitted as a CLR pinned local, mirroring C# `fixed (T* p = expr) { … }`.
/// @remarks The paren-less header (`fixed name *T = source`) follows the same
/// shape as G#'s other statement headers (`if`, `for`, `while`,
/// `unsafe { }`). `fixed` is a contextual keyword — the parser only
/// commits to this form for the exact `fixed IDENT *` shape, so existing
/// identifiers named `fixed` are unaffected.
partial class FixedStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:FixedStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param fixedKeyword The contextual `fixed` keyword token.
    /// @param identifier The pointer-binding identifier.
    /// @param typeClause The unmanaged pointer type clause (`*T`).
    /// @param equalsToken The `=` token.
    /// @param pinnedSource The managed array/string source expression to pin.
    /// @param body The block over which the pin is held.
    init(
        syntaxTree SyntaxTree,
        fixedKeyword SyntaxToken,
        identifier SyntaxToken,
        typeClause TypeClauseSyntax,
        equalsToken SyntaxToken,
        pinnedSource ExpressionSyntax,
        body BlockStatementSyntax
    ) : base(syntaxTree) {
        FixedKeyword = fixedKeyword
        Identifier = identifier
        TypeClause = typeClause
        EqualsToken = equalsToken
        PinnedSource = pinnedSource
        Body = body
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.FixedStatement

    /// Gets the contextual `fixed` keyword token.
    prop FixedKeyword SyntaxToken {
        get;
    }

    /// Gets the pointer-binding identifier.
    prop Identifier SyntaxToken {
        get;
    }

    /// Gets the unmanaged pointer type clause (`*T`).
    prop TypeClause TypeClauseSyntax {
        get;
    }

    /// Gets the `=` token.
    prop EqualsToken SyntaxToken {
        get;
    }

    /// Gets the managed array/string source expression to pin.
    prop PinnedSource ExpressionSyntax {
        get;
    }

    /// Gets the block over which the pin is held.
    prop Body BlockStatementSyntax {
        get;
    }
}
