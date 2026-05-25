// <copyright file="BoundAddressOfExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound expression representing the address-of operator <c>&amp;expr</c>.
/// The operand must be an lvalue. The result type is <c>*T</c> where T is the operand's type.
/// </summary>
public sealed class BoundAddressOfExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundAddressOfExpression"/> class.
    /// </summary>
    /// <param name="operand">The lvalue operand whose address is being taken.</param>
    public BoundAddressOfExpression(BoundExpression operand)
    {
        Operand = operand;
        Type = ByRefTypeSymbol.Get(operand.Type);
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.AddressOfExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type { get; }

    /// <summary>
    /// Gets the lvalue operand whose address is being taken.
    /// </summary>
    public BoundExpression Operand { get; }
}
