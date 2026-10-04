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
        IsLifted = ComputeIsLifted(source.Type, resultType, method, function, functionOwnerType);
        if (IsLifted && resultType is not NullableTypeSymbol)
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

    internal static bool CanLiftTo(TypeSymbol target)
        => target is NullableTypeSymbol nullable
            ? NullableLifting.IsAnyValueTypeNullable(nullable)
                || Conversion.IsReferenceLikeTarget(nullable.UnderlyingType)
            : Conversion.IsReferenceLikeTarget(target);

    internal static bool CanLiftImplicitlyTo(TypeSymbol target)
        => CanLiftTo(target)
            && Conversion.ClassifyNonStructural(NullableTypeSymbol.Get(target), target).IsImplicit;

    internal static bool CanApplyImplicitClrConversion(TypeSymbol source, TypeSymbol target, MethodInfo method)
        => !ComputeIsLifted(source, target, method, null, null) || CanLiftImplicitlyTo(target);

    private static bool ComputeIsLifted(
        TypeSymbol sourceType,
        TypeSymbol conversionType,
        MethodInfo? method,
        FunctionSymbol? function,
        StructSymbol? functionOwnerType)
    {
        if (sourceType is not NullableTypeSymbol source
            || !NullableLifting.IsAnyValueTypeNullable(source)
            || !CanLiftTo(conversionType))
        {
            return false;
        }

        var target = conversionType is NullableTypeSymbol nullable ? nullable.UnderlyingType : conversionType;
        if (function != null)
        {
            if (function.Parameters.Length != 1
                || function.Parameters[0].RefKind != RefKind.None
                || function.ReturnRefKind != RefKind.None)
            {
                return false;
            }

            var parameterType = functionOwnerType?.SubstituteMemberType(function.Parameters[0].Type)
                ?? function.Parameters[0].Type;
            var resultType = functionOwnerType?.SubstituteMemberType(function.Type) ?? function.Type;
            return Conversion.ClassifyNonStructural(source.UnderlyingType, parameterType).IsIdentity
                && TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(resultType, target);
        }

        var parameters = method?.GetParameters();
        return parameters is { Length: 1 }
            && !parameters[0].ParameterType.IsByRef
            && method is { ReturnType.IsByRef: false }
            && ClrTypeUtilities.AreSame(parameters[0].ParameterType, source.UnderlyingType.ClrType)
            && ClrTypeUtilities.AreSame(method.ReturnType, target.ClrType);
    }
}
