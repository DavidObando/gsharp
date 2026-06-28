#nullable disable

// <copyright file="BoundForInfiniteStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound for infinite statement.
/// </summary>
public sealed class BoundForInfiniteStatement : BoundLoopStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundForInfiniteStatement"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="body">The body.</param>
    /// <param name="breakLabel">The break label.</param>
    /// <param name="continueLabel">The continue label.</param>
    public BoundForInfiniteStatement(
        SyntaxNode syntax,
        BoundStatement body,
        BoundLabel breakLabel,
        BoundLabel continueLabel)
        : base(syntax, breakLabel, continueLabel)
    {
        Body = body;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.ForInfiniteStatement;

    /// <summary>
    /// Gets the body.
    /// </summary>
    public BoundStatement Body { get; }
}
