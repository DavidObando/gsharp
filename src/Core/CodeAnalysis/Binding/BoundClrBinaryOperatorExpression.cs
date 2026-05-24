// <copyright file="BoundClrBinaryOperatorExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// User-defined binary operator on an imported CLR type, resolved to a
/// public static <see cref="MethodInfo"/> with C#-style operator name
/// (e.g. <c>op_Addition</c>, <c>op_Equality</c>). Stream C lets GSharp source
/// write <c>a + b</c> against operator-bearing CLR types such as
/// <c>TimeSpan</c>, <c>BigInteger</c>, or <c>System.Numerics.Vector2</c>.
/// </summary>
public sealed class BoundClrBinaryOperatorExpression : BoundExpression
{
    public BoundClrBinaryOperatorExpression(SyntaxKind operatorKind, BoundExpression left, BoundExpression right, MethodInfo method, TypeSymbol resultType)
    {
        OperatorKind = operatorKind;
        Left = left;
        Right = right;
        Method = method;
        Type = resultType;
    }

    public SyntaxKind OperatorKind { get; }

    public BoundExpression Left { get; }

    public BoundExpression Right { get; }

    public MethodInfo Method { get; }

    public override TypeSymbol Type { get; }

    public override BoundNodeKind Kind => BoundNodeKind.ClrBinaryOperatorExpression;
}
