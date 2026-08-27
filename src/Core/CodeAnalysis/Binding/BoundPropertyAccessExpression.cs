// <copyright file="BoundPropertyAccessExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Represents a read access to a user-defined property (ADR-0051).
/// </summary>
public sealed class BoundPropertyAccessExpression : BoundExpression
{
    public BoundPropertyAccessExpression(SyntaxNode? syntax, BoundExpression? receiver, StructSymbol? structType, PropertySymbol property)
        : this(syntax, receiver, structType, property, substitutedType: null, narrowedType: null)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="BoundPropertyAccessExpression"/>
    /// class with a narrowed type. ADR-0069 addendum / issue #1180: used by
    /// smart-cast flow analysis to surface a narrowed (tested) view of an
    /// immutable property read through a stable access path, without changing
    /// the underlying property symbol identity (so the emitter still calls the
    /// same getter).
    /// </summary>
    /// <param name="syntax">The originating syntax, or <c>null</c> for synthesized nodes.</param>
    /// <param name="receiver">The instance receiver, or <see langword="null"/> for a static property.</param>
    /// <param name="structType">The declaring struct/class type.</param>
    /// <param name="property">The property to read.</param>
    /// <param name="narrowedType">The narrowed type to surface, or <c>null</c> to use <paramref name="property"/>'s declared type.</param>
    public BoundPropertyAccessExpression(SyntaxNode? syntax, BoundExpression? receiver, StructSymbol? structType, PropertySymbol property, TypeSymbol? narrowedType)
        : this(syntax, receiver, structType, property, substitutedType: null, narrowedType: narrowedType)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="BoundPropertyAccessExpression"/>
    /// class with distinct construction-substituted and flow-narrowed types.
    /// </summary>
    /// <param name="syntax">Originating syntax.</param>
    /// <param name="receiver">Instance receiver, or <see langword="null"/> for static access.</param>
    /// <param name="structType">Declaring struct/class type.</param>
    /// <param name="property">Property to read.</param>
    /// <param name="substitutedType">Construction-substituted member type.</param>
    /// <param name="narrowedType">Flow-narrowed type.</param>
    public BoundPropertyAccessExpression(
        SyntaxNode? syntax,
        BoundExpression? receiver,
        StructSymbol? structType,
        PropertySymbol property,
        TypeSymbol? substitutedType,
        TypeSymbol? narrowedType)
        : this(
            syntax,
            receiver,
            structType,
            property,
            substitutedType,
            narrowedType,
            interfaceType: null)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="BoundPropertyAccessExpression"/>
    /// class with distinct construction, narrowing, and interface-owner state.
    /// </summary>
    /// <param name="syntax">Originating syntax.</param>
    /// <param name="receiver">Instance receiver, or <see langword="null"/> for static access.</param>
    /// <param name="structType">Declaring struct/class type.</param>
    /// <param name="property">Property to read.</param>
    /// <param name="substitutedType">Construction-substituted member type.</param>
    /// <param name="narrowedType">Flow-narrowed type.</param>
    /// <param name="interfaceType">Effective interface owner, or <see langword="null"/>.</param>
    public BoundPropertyAccessExpression(
        SyntaxNode? syntax,
        BoundExpression? receiver,
        StructSymbol? structType,
        PropertySymbol property,
        TypeSymbol? substitutedType,
        TypeSymbol? narrowedType,
        InterfaceSymbol? interfaceType)
        : base(syntax)
    {
        Receiver = receiver;
        StructType = structType;
        Property = property;
        NarrowedType = narrowedType;
        SubstitutedType = substitutedType;
        InterfaceType = interfaceType;
    }

    /// <summary>Gets the instance receiver, or <see langword="null"/> for a static property.</summary>
    public BoundExpression? Receiver { get; }

    /// <summary>
    /// Gets the struct/class that declares <see cref="Property"/>, or
    /// <see langword="null"/> for an access through an interface-typed
    /// receiver, where the declaring type is the interface rather than an
    /// aggregate.
    /// </summary>
    public StructSymbol? StructType { get; }

    /// <summary>Gets the effective interface construction that declares <see cref="Property"/>.</summary>
    public InterfaceSymbol? InterfaceType { get; }

    public PropertySymbol Property { get; }

    /// <summary>
    /// Gets the narrowed type for flow-analysis smart-cast (ADR-0069 addendum /
    /// issue #1180), or <c>null</c> to use the property's declared type. When
    /// non-null the binder reports this type to callers so member-access and
    /// type-compatibility checks see the narrowed view; the emitter always uses
    /// <see cref="Property"/> for the getter call and inserts the narrowing cast.
    /// </summary>
    public TypeSymbol? NarrowedType { get; }

    /// <summary>Gets the member type after generic construction substitution, before flow narrowing.</summary>
    public TypeSymbol? SubstitutedType { get; }

    public override TypeSymbol Type => NarrowedType ?? SubstitutedType ?? Property.Type;

    public override BoundNodeKind Kind => BoundNodeKind.PropertyAccessExpression;
}
