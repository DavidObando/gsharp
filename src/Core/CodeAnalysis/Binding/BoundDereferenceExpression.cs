#nullable disable

// <copyright file="BoundDereferenceExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound expression representing the dereference operator <c>*expr</c>.
/// The operand must have type <c>*T</c> (<see cref="ByRefTypeSymbol"/>); the result type is <c>T</c>.
/// </summary>
public sealed class BoundDereferenceExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundDereferenceExpression"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="operand">The pointer expression to dereference.</param>
    public BoundDereferenceExpression(SyntaxNode syntax, BoundExpression operand)
        : base(syntax)
    {
        Operand = operand;
        Type = TypeSymbol.TryGetPointeeType(operand.Type, out var pointee)
            ? pointee
            : TypeSymbol.Error;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.DereferenceExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type { get; }

    /// <summary>
    /// Gets the pointer operand being dereferenced.
    /// </summary>
    public BoundExpression Operand { get; }
}
