// <copyright file="RethrowStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Represents a `rethrow` statement (ADR-0176, issue #3897).
/// @remarks `rethrow` re-raises the exception currently being handled by the
/// lexically innermost enclosing `catch` clause, emitting
/// `ILOpCode.Rethrow`. Unlike `throw expr` (which emits
/// `ILOpCode.Throw` and resets (cref:System.Exception.StackTrace)
/// to the throw site), a rethrow preserves the original throw site.
///
/// G# spells this with a dedicated keyword rather than C#'s bare
/// `throw;`: G# statements are not newline-terminated, so a bare
/// `throw` followed by a statement on the next line would be parsed as
/// `throw <that expression>`.
class RethrowStatementSyntax : StatementSyntax {
    /// Initializes a new instance of the (cref:RethrowStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param rethrowKeyword The `rethrow` keyword.
    init(syntaxTree SyntaxTree, rethrowKeyword SyntaxToken) : base(syntaxTree) {
        RethrowKeyword = rethrowKeyword
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.RethrowStatement

    /// Gets the `rethrow` keyword.
    prop RethrowKeyword SyntaxToken {
        get;
    }
}
