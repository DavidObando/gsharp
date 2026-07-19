// <copyright file="BoundClrPropertyAccessExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using System.Reflection;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Reads a public <see cref="PropertyInfo"/> or <see cref="FieldInfo"/> on a
/// CLR receiver. When <see cref="Receiver"/> is <see langword="null"/>, the
/// member is static; otherwise it is dispatched against the instance
/// receiver. Examples: <c>lst.Count</c>, <c>sb.Length</c>, <c>kvp.Key</c>,
/// <c>Console.Out</c> (static, since Stream B).
/// </summary>
public sealed class BoundClrPropertyAccessExpression : BoundExpression
{
    public BoundClrPropertyAccessExpression(
        SyntaxNode syntax,
        BoundExpression receiver,
        MemberInfo member,
        TypeSymbol resultType,
        TypeSymbol staticContainerType = null,
        TypeParameterSymbol constrainedReceiverTypeParameter = null,
        TypeSymbol constrainedInterfaceType = null)
        : base(syntax)
    {
        Receiver = receiver;
        Member = member;
        Type = resultType;
        StaticContainerType = staticContainerType;
        ConstrainedReceiverTypeParameter = constrainedReceiverTypeParameter;
        ConstrainedInterfaceType = constrainedInterfaceType;
    }

    public BoundExpression Receiver { get; }

    public MemberInfo Member { get; }

    /// <summary>
    /// Gets, for a static member read on a generic type constructed over
    /// an in-scope generic type parameter (e.g. <c>Comparer[TResult].Default</c>),
    /// the symbolic constructed container (an <see cref="ImportedTypeSymbol"/>
    /// over the open definition with symbolic type arguments). The emitter
    /// parents the static getter/field reference at this constructed TypeSpec
    /// (<c>Comparer&lt;!TResult&gt;</c>) instead of the erased
    /// <c>Comparer&lt;object&gt;</c>. <c>null</c> for an ordinary static or
    /// instance member access.
    /// </summary>
    public TypeSymbol StaticContainerType { get; }

    /// <summary>Gets the type parameter used for constrained interface dispatch, if any.</summary>
    public TypeParameterSymbol ConstrainedReceiverTypeParameter { get; }

    /// <summary>Gets the imported interface that owns the constrained member reference, if any.</summary>
    public TypeSymbol ConstrainedInterfaceType { get; }

    /// <summary>Gets a value indicating whether this access dispatches through a type-parameter constraint.</summary>
    public bool IsConstrainedTypeParameterAccess => ConstrainedReceiverTypeParameter != null;

    public override TypeSymbol Type { get; }

    public override BoundNodeKind Kind => BoundNodeKind.ClrPropertyAccessExpression;
}
