// <copyright file="BoundRethrowStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound <c>rethrow</c> statement (ADR-0176, issue #3897).
/// </summary>
/// <remarks>
/// Carries no operand: the exception re-raised is the one the enclosing CLR
/// catch handler is processing, which lives in the handler frame rather than
/// in any expression the emitter can name. This is why it emits
/// <c>ILOpCode.Rethrow</c> and preserves the original stack trace, where
/// <see cref="BoundThrowStatement"/> emits <c>ILOpCode.Throw</c> and resets it.
/// </remarks>
public sealed class BoundRethrowStatement : BoundStatement
{
    /// <summary>Initializes a new instance of the <see cref="BoundRethrowStatement"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    public BoundRethrowStatement(SyntaxNode? syntax)
        : base(syntax)
    {
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.RethrowStatement;
}
