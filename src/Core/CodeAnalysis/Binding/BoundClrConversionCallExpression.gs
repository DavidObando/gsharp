// <copyright file="BoundClrConversionCallExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Reflection

/// User-defined conversion resolved to a public static `op_Implicit` or
/// `op_Explicit`, carried by either (cref:Method) for imported
/// CLR types or (cref:Function) for same-compilation user types.
/// Stream E lets GSharp source assign across types that carry CLR conversion
/// operators (e.g. `System.Numerics.BigInteger` ↔ `int`,
/// `System.Half` ↔ `float`).
class BoundClrConversionCallExpression : BoundExpression {
    convenience init(syntax SyntaxNode?, source BoundExpression, method MethodInfo, resultType TypeSymbol) {
        init(syntax, source, method, nil, nil, resultType)
    }

    convenience init(syntax SyntaxNode?, source BoundExpression, function FunctionSymbol, resultType TypeSymbol) {
        init(syntax, source, function, function.StaticOwnerType as StructSymbol, resultType)
    }

    convenience init(
        syntax SyntaxNode?,
        source BoundExpression,
        function FunctionSymbol,
        functionOwnerType StructSymbol?,
        resultType TypeSymbol
    ) {
        init(syntax, source, nil, function, functionOwnerType, resultType)
    }

    private init(
        syntax SyntaxNode?,
        source BoundExpression,
        method MethodInfo?,
        function FunctionSymbol?,
        functionOwnerType StructSymbol?,
        resultType TypeSymbol
    ) : base(syntax) {
        Source = source
        Method = method
        Function = function
        FunctionOwnerType = functionOwnerType
        IsLifted = ComputeIsLifted(source.Type, resultType, method, function, functionOwnerType)
        _type = GetEffectiveResultType(source.Type, resultType, method, IsLifted)
    }

    prop Source BoundExpression {
        get;
    }

    prop Method MethodInfo? {
        get;
    }

    prop Function FunctionSymbol? {
        get;
    }

    prop FunctionOwnerType StructSymbol? {
        get;
    }

    private var _type TypeSymbol
    override prop Type TypeSymbol -> _type
    override prop Kind BoundNodeKind -> BoundNodeKind.ClrConversionCallExpression

    internal prop IsLifted bool {
        get;
    }

    shared {
        internal func CanLiftTo(target TypeSymbol) bool -> if target is NullableTypeSymbol nullable {
            NullableLifting.IsAnyValueTypeNullable(nullable) || Conversion.IsReferenceLikeTarget(
                nullable.UnderlyingType
            )
        } else {
            Conversion.IsReferenceLikeTarget(target)
        }

        internal func CanLiftImplicitlyTo(target TypeSymbol) bool -> CanLiftTo(target) &&
            Conversion
            .ClassifyNonStructural(NullableTypeSymbol.Get(target), target).IsImplicit

        internal func CanApplyImplicitClrConversion(
            source TypeSymbol,
            target TypeSymbol,
            method MethodInfo
        ) bool -> Conversion
            .ClassifyNonStructural(
            GetEffectiveResultType(source, target, method, ComputeIsLifted(source, target, method, nil, nil)),
            target
        )
            .IsImplicit

        private func GetEffectiveResultType(
            source TypeSymbol,
            target TypeSymbol,
            method MethodInfo?,
            isLifted bool
        ) TypeSymbol {
            if isLifted {
                return NullableTypeSymbol.Get(target)
            }
            if source is NullableTypeSymbol nullable && NullableLifting.IsAnyValueTypeNullable(nullable) &&
                method?.GetParameters() is {Length: 1} parameters && ClrTypeUtilities.AreSame(
                parameters[0].ParameterType,
                NullableLifting.GetEffectiveClrType(source)
            ) {
                let declaredResult = ClrNullability.GetReturnTypeSymbol(method!!)
                if TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(declaredResult, target) &&
                    !Conversion
                    .ClassifyNonStructural(declaredResult, target).IsImplicit {
                    return declaredResult
                }
            }
            return target
        }

        private func ComputeIsLifted(
            sourceType TypeSymbol,
            conversionType TypeSymbol,
            method MethodInfo?,
            function FunctionSymbol?,
            functionOwnerType StructSymbol?
        ) bool {
            if sourceType is not NullableTypeSymbol source || !NullableLifting.IsAnyValueTypeNullable(source) ||
                !CanLiftTo(conversionType) {
                return false
            }
            let target = if conversionType is NullableTypeSymbol nullable {
                nullable.UnderlyingType
            } else {
                conversionType
            }
            if function != nil {
                if function
                    .Parameters
                    .Length != 1 ||
                    function
                    .Parameters[0]
                    .RefKind != RefKind.None ||
                    function.ReturnRefKind != RefKind.None {
                    return false
                }
                let parameterType = functionOwnerType?.SubstituteMemberType(function.Parameters[0].Type) ??
                    function
                    .Parameters[0]
                    .Type
                let resultType = functionOwnerType?.SubstituteMemberType(function.Type) ?? function.Type
                return Conversion.ClassifyNonStructural(source.UnderlyingType, parameterType)
                    .IsIdentity &&
                    TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(resultType, target)
            }
            let parameters = method?.GetParameters()
            return parameters != nil &&
                parameters.Length == 1 &&
                !parameters[0]
                .ParameterType
                .IsByRef &&
                method != nil &&
                method
                .ReturnType
                .IsByRef == false &&
                ClrTypeUtilities.AreSame(parameters[0].ParameterType, source.UnderlyingType.ClrType) &&
                ClrTypeUtilities.AreSame(method.ReturnType, target.ClrType)
        }
    }
}
