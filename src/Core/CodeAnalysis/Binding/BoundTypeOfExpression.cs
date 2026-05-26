// <copyright file="BoundTypeOfExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound built-in <c>typeof(T)</c> expression (issue #143). Carries the
/// referenced <see cref="TypeSymbol"/> payload; emits as
/// <c>ldtoken &lt;T&gt;</c> followed by a call to
/// <c>System.Type.GetTypeFromHandle</c>. Its result type is <c>System.Type</c>.
/// </summary>
public sealed class BoundTypeOfExpression : BoundExpression
{
    /// <summary>Initializes a new instance of the <see cref="BoundTypeOfExpression"/> class.</summary>
    /// <param name="operandType">The type that this <c>typeof</c> references.</param>
    /// <param name="systemType">The <c>System.Type</c> symbol used as the result type.</param>
    public BoundTypeOfExpression(TypeSymbol operandType, TypeSymbol systemType)
    {
        OperandType = operandType;
        Type = systemType;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.TypeOfExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type { get; }

    /// <summary>Gets the referenced type symbol.</summary>
    public TypeSymbol OperandType { get; }
}
