// <copyright file="BoundClrPropertyAssignmentExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using System.Diagnostics.CodeAnalysis;
using System.Reflection;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Writes a public <see cref="PropertyInfo"/> or <see cref="FieldInfo"/> on a
/// CLR receiver. When <see cref="Receiver"/> is <see langword="null"/>, the
/// member is static; otherwise it is an instance member dispatched against
/// the receiver. Stream B parity for imported-type member writes; mirrors the
/// read-only <see cref="BoundClrPropertyAccessExpression"/>.
/// </summary>
public sealed class BoundClrPropertyAssignmentExpression : BoundExpression
{
    public BoundClrPropertyAssignmentExpression(
        SyntaxNode? syntax,
        BoundExpression? receiver,
        MemberInfo member,
        BoundExpression value,
        TypeSymbol resultType,
        TypeSymbol? staticContainerType,
        TypeParameterSymbol? constrainedReceiverTypeParameter = null,
        TypeSymbol? constrainedInterfaceType = null)
        : base(syntax)
    {
        Receiver = receiver;
        Member = member;
        Value = value;
        Type = resultType;
        ConstrainedReceiverTypeParameter = constrainedReceiverTypeParameter;
        ConstrainedInterfaceType = constrainedInterfaceType;
        StaticContainerType = staticContainerType
            ?? MemberLookup.GetClrFieldReferenceContainer(receiver?.Type, member);
    }

    /// <summary>Gets the receiver, or <c>null</c> when the member is
    /// static -- see the remarks on this type.</summary>
    public BoundExpression? Receiver { get; }

    public MemberInfo Member { get; }

    public BoundExpression Value { get; }

    public TypeParameterSymbol? ConstrainedReceiverTypeParameter { get; }

    public TypeSymbol? ConstrainedInterfaceType { get; }

    /// <summary>Gets the symbolic declaring type used to parent a generic
    /// static or instance field reference, or <c>null</c> when no TypeSpec
    /// parent is needed.</summary>
    public TypeSymbol? StaticContainerType { get; }

    [MemberNotNullWhen(true, nameof(ConstrainedReceiverTypeParameter))]
    public bool IsConstrainedTypeParameterAccess => ConstrainedReceiverTypeParameter != null;

    public override TypeSymbol Type { get; }

    public override BoundNodeKind Kind => BoundNodeKind.ClrPropertyAssignmentExpression;
}
