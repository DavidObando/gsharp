#nullable disable

// <copyright file="BoundClrConversionCallExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using System.Reflection;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// User-defined conversion on a CLR type, resolved to a public static
/// <c>op_Implicit</c> or <c>op_Explicit</c> <see cref="MethodInfo"/>.
/// Stream E lets GSharp source assign across types that carry CLR conversion
/// operators (e.g. <c>System.Numerics.BigInteger</c> ↔ <c>int</c>,
/// <c>System.Half</c> ↔ <c>float</c>).
/// </summary>
public sealed class BoundClrConversionCallExpression : BoundExpression
{
    public BoundClrConversionCallExpression(SyntaxNode syntax, BoundExpression source, MethodInfo method, TypeSymbol resultType)
        : base(syntax)
    {
        Source = source;
        Method = method;
        Type = resultType;
    }

    public BoundExpression Source { get; }

    public MethodInfo Method { get; }

    public override TypeSymbol Type { get; }

    public override BoundNodeKind Kind => BoundNodeKind.ClrConversionCallExpression;
}
