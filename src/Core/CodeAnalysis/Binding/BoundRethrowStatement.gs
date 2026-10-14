// <copyright file="BoundRethrowStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Syntax

/// Bound `rethrow` statement (ADR-0176, issue #3897).
/// @remarks Carries no operand: the exception re-raised is the one the enclosing CLR
/// catch handler is processing, which lives in the handler frame rather than
/// in any expression the emitter can name. This is why it emits
/// `ILOpCode.Rethrow` and preserves the original stack trace, where
/// (cref:BoundThrowStatement) emits `ILOpCode.Throw` and resets it.
class BoundRethrowStatement : BoundStatement {
    /// Initializes a new instance of the (cref:BoundRethrowStatement) class.
    /// @param syntax The originating syntax.
    init(syntax SyntaxNode?) : base(syntax) { }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.RethrowStatement
}
