// <copyright file="BoundClrPropertyAccessExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Reads a public instance <see cref="PropertyInfo"/> or <see cref="FieldInfo"/>
/// on a CLR receiver (Phase 4 exit). Examples: <c>lst.Count</c>,
/// <c>sb.Length</c>, <c>kvp.Key</c>. Interpreter-only — the evaluator dispatches
/// via <c>PropertyInfo.GetValue</c> / <c>FieldInfo.GetValue</c>.
/// </summary>
public sealed class BoundClrPropertyAccessExpression : BoundExpression
{
    public BoundClrPropertyAccessExpression(BoundExpression receiver, MemberInfo member, TypeSymbol resultType)
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
