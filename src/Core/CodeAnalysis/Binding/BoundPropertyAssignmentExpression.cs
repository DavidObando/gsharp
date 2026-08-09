// <copyright file="BoundPropertyAssignmentExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Represents an assignment to a user-defined property (ADR-0051).
/// </summary>
public sealed class BoundPropertyAssignmentExpression : BoundExpression
{
    /// <summary>Initializes a new instance of the <see cref="BoundPropertyAssignmentExpression"/> class.</summary>
    /// <param name="syntax">The originating syntax, or <see langword="null"/> for synthesized nodes.</param>
    /// <param name="receiver">The instance receiver, or <see langword="null"/> for a static property.</param>
    /// <param name="structType">The declaring struct/class type.</param>
    /// <param name="property">The property to write.</param>
    /// <param name="value">The value to assign.</param>
    public BoundPropertyAssignmentExpression(
        SyntaxNode? syntax,
        BoundExpression? receiver,
        StructSymbol structType,
        PropertySymbol property,
        BoundExpression value)
        : base(syntax)
    {
        Receiver = receiver;
        StructType = structType;
        Property = property;
        Value = value;
    }

    /// <summary>Gets the instance receiver, or <see langword="null"/> for a static property.</summary>
    public BoundExpression? Receiver { get; }

    public StructSymbol StructType { get; }

    public PropertySymbol Property { get; }

    public BoundExpression Value { get; }

    public override TypeSymbol Type => Property.Type;

    public override BoundNodeKind Kind => BoundNodeKind.PropertyAssignmentExpression;
}
