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
        IsLifted = ComputeIsLifted();
        if (IsLifted && !resultType.IsValueType)
        {
            // The effective conversion can return nil even when op_Explicit
            // itself promises a non-null reference result (#4741).
            Type = NullableTypeSymbol.Get(resultType);
        }
    }

    public BoundExpression Source { get; }

    public MethodInfo? Method { get; }

    public FunctionSymbol? Function { get; }

    public StructSymbol? FunctionOwnerType { get; }

    public override TypeSymbol Type { get; }

    public override BoundNodeKind Kind => BoundNodeKind.ClrConversionCallExpression;

    internal bool IsLifted { get; }

    private bool ComputeIsLifted()
    {
        if (Source.Type is not NullableTypeSymbol source
            || !NullableLifting.IsAnyValueTypeNullable(source)
            || (Type.IsValueType && Type is not NullableTypeSymbol))
        {
            return false;
        }

        var target = Type is NullableTypeSymbol nullable ? nullable.UnderlyingType : Type;
        if (Function != null)
        {
            if (Function.Parameters.Length != 1
                || Function.Parameters[0].RefKind != RefKind.None
                || Function.ReturnRefKind != RefKind.None)
            {
                return false;
            }

            var parameterType = FunctionOwnerType?.SubstituteMemberType(Function.Parameters[0].Type)
                ?? Function.Parameters[0].Type;
            var resultType = FunctionOwnerType?.SubstituteMemberType(Function.Type) ?? Function.Type;
            return Conversion.ClassifyNonStructural(source.UnderlyingType, parameterType).IsIdentity
                && TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(resultType, target);
        }

        var parameters = Method?.GetParameters();
        return parameters is { Length: 1 }
            && !parameters[0].ParameterType.IsByRef
            && Method is { ReturnType.IsByRef: false }
            && ClrTypeUtilities.AreSame(parameters[0].ParameterType, source.UnderlyingType.ClrType)
            && ClrTypeUtilities.AreSame(Method.ReturnType, target.ClrType);
    }
}
