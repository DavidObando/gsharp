#nullable disable

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
    public BoundClrPropertyAccessExpression(SyntaxNode syntax, BoundExpression receiver, MemberInfo member, TypeSymbol resultType)
        : base(syntax)
    {
        Receiver = receiver;
        Member = member;
        Type = resultType;
    }

    public BoundExpression Receiver { get; }

    public MemberInfo Member { get; }

    public override TypeSymbol Type { get; }

    public override BoundNodeKind Kind => BoundNodeKind.ClrPropertyAccessExpression;
}
