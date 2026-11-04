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
        Source = WrapNonNullableValueOperand(source, method)
        Method = method
        Function = function
        FunctionOwnerType = functionOwnerType
        IsLifted = ComputeIsLifted(Source.Type, resultType, method, function, functionOwnerType)
        _type = GetEffectiveResultType(Source.Type, resultType, method, IsLifted)
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

        internal func CanApplyImplicitClrConversion(source TypeSymbol, target TypeSymbol, method MethodInfo) bool {
            let effectiveSource = GetEffectiveOperandType(source, method)
            let isLifted = ComputeIsLifted(effectiveSource, target, method, nil, nil)
            if effectiveSource is NullableTypeSymbol nullable && NullableLifting.IsAnyValueTypeNullable(nullable) &&
                !isLifted &&
                !AcceptsNullableValueSource(nullable, target, method, out _) {
                return false
            }
            return Conversion.ClassifyNonStructural(
                GetEffectiveResultType(effectiveSource, target, method, isLifted),
                target
            )
                .IsImplicit
        }

        private func WrapNonNullableValueOperand(source BoundExpression, method MethodInfo?) BoundExpression {
            let effectiveSource = GetEffectiveOperandType(source.Type, method)
            return if object.ReferenceEquals(effectiveSource, source.Type) {
                source
            } else {
                cast[BoundExpression](BoundConversionExpression(source.Syntax, effectiveSource, source))
            }
        }

        private func GetEffectiveOperandType(source TypeSymbol, method MethodInfo?) TypeSymbol ->
        if source is not NullableTypeSymbol && !TypeSymbol.IsByRefLike(source) && method?.GetParameters() is {
            Length: 1
        } parameters &&
            NullableLifting.IsValueTypeNullableClr(parameters[0].ParameterType) {
            NullableTypeSymbol.Get(source.StripToBareShape())
        } else {
            source
        }

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
                method != nil &&
                AcceptsNullableValueSource(nullable, target, method, out var declaredResult) {
                if TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(declaredResult, target) &&
                    !Conversion
                    .ClassifyNonStructural(declaredResult, target).IsImplicit {
                    return declaredResult
                }
            }
            return target
        }

        private func AcceptsNullableValueSource(
            source NullableTypeSymbol,
            target TypeSymbol,
            method MethodInfo,
            out declaredResult TypeSymbol
        ) bool {
            declaredResult = target
            if method.GetParameters() is not{Length: 1} parameters {
                return false
            }
            if method.DeclaringType is {IsGenericTypeDefinition: true} openDeclaring {
                let sourceUnderlying = source.UnderlyingType.StripToBareShape()
                let targetUnderlying = if target.StripToBareShape() is NullableTypeSymbol nullableTarget {
                    nullableTarget.UnderlyingType.StripToBareShape()
                } else {
                    target.StripToBareShape()
                }
                let symbolicOwner ImportedTypeSymbol? = if sourceUnderlying is ImportedTypeSymbol{
                    OpenDefinition: {} sourceOpen
                } importedSource &&
                    !importedSource
                    .TypeArguments
                    .IsDefaultOrEmpty &&
                    ClrTypeUtilities.AreSame(sourceOpen, openDeclaring) {
                    importedSource
                } else if targetUnderlying is ImportedTypeSymbol{OpenDefinition: {} targetOpen} importedTarget &&
                    !importedTarget
                    .TypeArguments
                    .IsDefaultOrEmpty &&
                    ClrTypeUtilities.AreSame(targetOpen, openDeclaring) {
                    importedTarget
                } else {
                    nil
                }
                if symbolicOwner == nil {
                    return false
                }
                let mappedParameter = MemberLookup.GetClrOpenParameterPointeeTypeSymbol(
                    parameters[0],
                    openDeclaring,
                    symbolicOwner.TypeArguments
                )
                    .StripToBareShape()
                if !Conversion.ClassifyNonStructural(source, mappedParameter).IsIdentity {
                    return false
                }
                declaredResult = MemberLookup.GetClrOpenMethodReturnTypeSymbol(
                    method,
                    openDeclaring,
                    symbolicOwner.TypeArguments
                )
                return true
            }
            if !ClrTypeUtilities.AreSame(parameters[0].ParameterType, NullableLifting.GetEffectiveClrType(source)) {
                return false
            }
            declaredResult = ClrNullability.GetReturnTypeSymbol(method)
            return true
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
                    (
                    TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(resultType, target) ||
                        TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(resultType, conversionType)
                )
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
                (
                ClrTypeUtilities.AreSame(method.ReturnType, target.ClrType) || ClrTypeUtilities.AreSame(
                    method.ReturnType,
                    NullableLifting.GetEffectiveClrType(conversionType)
                )
            )
        }
    }
}
