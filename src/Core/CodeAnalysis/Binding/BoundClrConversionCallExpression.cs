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
/// User-defined conversion resolved to a public static <c>op_Implicit</c> or
/// <c>op_Explicit</c>, carried by either <see cref="Method"/> for imported
/// CLR types or <see cref="Function"/> for same-compilation user types.
/// Stream E lets GSharp source assign across types that carry CLR conversion
/// operators (e.g. <c>System.Numerics.BigInteger</c> ↔ <c>int</c>,
/// <c>System.Half</c> ↔ <c>float</c>).
/// </summary>
public sealed class BoundClrConversionCallExpression : BoundExpression
{
    public BoundClrConversionCallExpression(SyntaxNode? syntax, BoundExpression source, MethodInfo method, TypeSymbol resultType)
        : this(syntax, source, method, null, null, resultType)
    {
    }

    public BoundClrConversionCallExpression(SyntaxNode? syntax, BoundExpression source, FunctionSymbol function, TypeSymbol resultType)
        : this(syntax, source, function, function.StaticOwnerType as StructSymbol, resultType)
    {
    }

    public BoundClrConversionCallExpression(
        SyntaxNode? syntax,
        BoundExpression source,
        FunctionSymbol function,
        StructSymbol? functionOwnerType,
        TypeSymbol resultType)
        : this(syntax, source, null, function, functionOwnerType, resultType)
    {
    }

    private BoundClrConversionCallExpression(
        SyntaxNode? syntax,
        BoundExpression source,
        MethodInfo? method,
        FunctionSymbol? function,
        StructSymbol? functionOwnerType,
        TypeSymbol resultType)
        : base(syntax)
    {
        Source = source;
        Method = method;
        Function = function;
        FunctionOwnerType = functionOwnerType;
        Type = resultType;
    }

    public BoundExpression Source { get; }

    public MethodInfo? Method { get; }

    public FunctionSymbol? Function { get; }

    public StructSymbol? FunctionOwnerType { get; }

    public override TypeSymbol Type { get; }

    public override BoundNodeKind Kind => BoundNodeKind.ClrConversionCallExpression;
}
