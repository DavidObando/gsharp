// <copyright file="BoundAddressOfExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

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
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="operand">The lvalue operand whose address is being taken.</param>
    public BoundAddressOfExpression(SyntaxNode syntax, BoundExpression operand)
        : this(syntax, operand, unmanaged: false)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="BoundAddressOfExpression"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="operand">The lvalue operand whose address is being taken.</param>
    /// <param name="unmanaged">
    /// ADR-0122 / issue #1014: when <see langword="true"/> the result is an
    /// <em>unmanaged</em> raw pointer (<see cref="PointerTypeSymbol"/>,
    /// <c>T*</c>) — used inside an <c>unsafe</c> context. When
    /// <see langword="false"/> (the default) the result is a managed by-ref
    /// pointer (<see cref="ByRefTypeSymbol"/>, <c>T&amp;</c>).
    /// </param>
    public BoundAddressOfExpression(SyntaxNode syntax, BoundExpression operand, bool unmanaged)
        : base(syntax)
    {
        Operand = operand;
        IsUnmanaged = unmanaged;
        Type = unmanaged ? PointerTypeSymbol.Get(operand.Type) : ByRefTypeSymbol.Get(operand.Type);
    }

    /// <summary>
    /// Gets a value indicating whether this address-of produces an unmanaged raw
    /// pointer (<c>T*</c>) rather than a managed by-ref (<c>T&amp;</c>).
    /// ADR-0122 / issue #1014.
    /// </summary>
    public bool IsUnmanaged { get; }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.AddressOfExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type { get; }

    /// <summary>
    /// Gets the lvalue operand whose address is being taken.
    /// </summary>
    public BoundExpression Operand { get; }
}
