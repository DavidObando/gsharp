#nullable disable

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
    public BoundPropertyAccessExpression(SyntaxNode syntax, BoundExpression receiver, StructSymbol structType, PropertySymbol property)
        : this(syntax, receiver, structType, property, narrowedType: null)
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
    /// <param name="receiver">The expression that produces the instance.</param>
    /// <param name="structType">The declaring struct/class type.</param>
    /// <param name="property">The property to read.</param>
    /// <param name="narrowedType">The narrowed type to surface, or <c>null</c> to use <paramref name="property"/>'s declared type.</param>
    public BoundPropertyAccessExpression(SyntaxNode syntax, BoundExpression receiver, StructSymbol structType, PropertySymbol property, TypeSymbol narrowedType)
        : base(syntax)
    {
        Receiver = receiver;
        StructType = structType;
        Property = property;
        NarrowedType = narrowedType;
    }

    public BoundExpression Receiver { get; }

    public StructSymbol StructType { get; }

    public PropertySymbol Property { get; }

    /// <summary>
    /// Gets the narrowed type for flow-analysis smart-cast (ADR-0069 addendum /
    /// issue #1180), or <c>null</c> to use the property's declared type. When
    /// non-null the binder reports this type to callers so member-access and
    /// type-compatibility checks see the narrowed view; the emitter always uses
    /// <see cref="Property"/> for the getter call and inserts the narrowing cast.
    /// </summary>
    public TypeSymbol NarrowedType { get; }

    public override TypeSymbol Type => NarrowedType ?? Property.Type;

    public override BoundNodeKind Kind => BoundNodeKind.PropertyAccessExpression;
}
