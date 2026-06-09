// <copyright file="BoundAwaitExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound <c>await</c> expression (Phase 5.1 / ADR-0023). At runtime the
/// operand is a <see cref="System.Threading.Tasks.Task"/> (or
/// <see cref="System.Threading.Tasks.Task{TResult}"/>); the expression yields
/// the unwrapped result type.
/// </summary>
public sealed class BoundAwaitExpression : BoundExpression
{
    /// <summary>Initializes a new instance of the <see cref="BoundAwaitExpression"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="expression">The expression being awaited.</param>
    /// <param name="type">The unwrapped type that the await yields.</param>
    /// <param name="awaiterTypeSymbol">The symbolic awaiter type used by lowering/emission.</param>
    public BoundAwaitExpression(SyntaxNode syntax, BoundExpression expression, TypeSymbol type, TypeSymbol awaiterTypeSymbol = null)
        : base(syntax)
    {
        Expression = expression;
        Type = type;
        AwaiterTypeSymbol = awaiterTypeSymbol;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.AwaitExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type { get; }

    /// <summary>Gets the awaited expression. Its runtime value must be a <c>Task</c> or <c>Task[T]</c>.</summary>
    public BoundExpression Expression { get; }

    /// <summary>Gets the symbolic awaiter type used when the operand was bound through an erased placeholder CLR type.</summary>
    public TypeSymbol AwaiterTypeSymbol { get; }
}
