// <copyright file="BoundClrPropertyAssignmentExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
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
        SyntaxNode syntax,
        BoundExpression receiver,
        MemberInfo member,
        BoundExpression value,
        TypeSymbol resultType,
        TypeParameterSymbol constrainedReceiverTypeParameter = null,
        TypeSymbol constrainedInterfaceType = null)
        : base(syntax)
    {
        Receiver = receiver;
        Member = member;
        Value = value;
        Type = resultType;
        ConstrainedReceiverTypeParameter = constrainedReceiverTypeParameter;
        ConstrainedInterfaceType = constrainedInterfaceType;
    }

    public BoundExpression Receiver { get; }

    public MemberInfo Member { get; }

    public BoundExpression Value { get; }

    public TypeParameterSymbol ConstrainedReceiverTypeParameter { get; }

    public TypeSymbol ConstrainedInterfaceType { get; }

    public bool IsConstrainedTypeParameterAccess => ConstrainedReceiverTypeParameter != null;

    public override TypeSymbol Type { get; }

    public override BoundNodeKind Kind => BoundNodeKind.ClrPropertyAssignmentExpression;
}
