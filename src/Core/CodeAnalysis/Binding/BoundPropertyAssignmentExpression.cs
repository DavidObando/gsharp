// <copyright file="BoundPropertyAssignmentExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

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
    /// <param name="structType">The declaring struct/class type, or <see langword="null"/> for an interface-constrained property.</param>
    /// <param name="property">The property to write.</param>
    /// <param name="value">The value to assign.</param>
    public BoundPropertyAssignmentExpression(
        SyntaxNode? syntax,
        BoundExpression? receiver,
        StructSymbol? structType,
        PropertySymbol property,
        BoundExpression value)
        : this(
            syntax,
            receiver,
            structType,
            property,
            value,
            substitutedType: null,
            interfaceType: null)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="BoundPropertyAssignmentExpression"/> class with generic-construction context.</summary>
    /// <param name="syntax">Originating syntax.</param>
    /// <param name="receiver">Instance receiver.</param>
    /// <param name="structType">Declaring struct/class type.</param>
    /// <param name="property">Property to write.</param>
    /// <param name="value">Converted assigned value.</param>
    /// <param name="substitutedType">Construction-substituted property type.</param>
    /// <param name="interfaceType">Effective interface owner.</param>
    public BoundPropertyAssignmentExpression(
        SyntaxNode? syntax,
        BoundExpression? receiver,
        StructSymbol? structType,
        PropertySymbol property,
        BoundExpression value,
        TypeSymbol? substitutedType,
        InterfaceSymbol? interfaceType)
        : base(syntax)
    {
        Receiver = receiver;
        StructType = structType;
        Property = property;
        Value = value;
        SubstitutedType = substitutedType;
        InterfaceType = interfaceType;
    }

    /// <summary>Gets the instance receiver, or <see langword="null"/> for a static property.</summary>
    public BoundExpression? Receiver { get; }

    public StructSymbol? StructType { get; }

    /// <summary>Gets the effective interface construction that declares <see cref="Property"/>.</summary>
    public InterfaceSymbol? InterfaceType { get; }

    public PropertySymbol Property { get; }

    public BoundExpression Value { get; }

    /// <summary>Gets the property type after generic construction substitution.</summary>
    public TypeSymbol? SubstitutedType { get; }

    public override TypeSymbol Type => SubstitutedType ?? Property.Type;

    public override BoundNodeKind Kind => BoundNodeKind.PropertyAssignmentExpression;
}
