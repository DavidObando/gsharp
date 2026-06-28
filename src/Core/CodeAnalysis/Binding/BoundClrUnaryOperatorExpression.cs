#nullable disable

// <copyright file="BoundClrUnaryOperatorExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// User-defined unary operator on an imported CLR type, resolved to a public
/// static <see cref="MethodInfo"/> (<c>op_UnaryNegation</c>,
/// <c>op_UnaryPlus</c>, <c>op_LogicalNot</c>, <c>op_OnesComplement</c>).
/// Stream C companion to <see cref="BoundClrBinaryOperatorExpression"/>.
/// </summary>
public sealed class BoundClrUnaryOperatorExpression : BoundExpression
{
    public BoundClrUnaryOperatorExpression(SyntaxNode syntax, SyntaxKind operatorKind, BoundExpression operand, MethodInfo method, TypeSymbol resultType)
        : base(syntax)
    {
        OperatorKind = operatorKind;
        Operand = operand;
        Method = method;
        Type = resultType;
    }

    public SyntaxKind OperatorKind { get; }

    public BoundExpression Operand { get; }

    public MethodInfo Method { get; }

    public override TypeSymbol Type { get; }

    public override BoundNodeKind Kind => BoundNodeKind.ClrUnaryOperatorExpression;
}
