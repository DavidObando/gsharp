// <copyright file="DelegateRefKindUtilities.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection

internal shared class DelegateRefKindUtilities {
    internal func TryGetSourceParameterRefKinds(expression BoundExpression, out refKinds ImmutableArray[RefKind]) bool {
        var expression = expression
        while expression is BoundConversionExpression conversion {
            expression = conversion.Expression
        }
        switch expression {
            case literal is BoundFunctionLiteralExpression {
                refKinds = GetParameterRefKinds(literal.Function, receiver: nil)
                return true
            }
            case group is BoundMethodGroupExpression {
                return TryGetMethodGroupParameterRefKinds(group, out refKinds)
            }
            case group is BoundClrMethodGroupExpression {
                return TryGetClrMethodGroupParameterRefKinds(group, out refKinds)
            }
            case {Type: sourceDelegate is DelegateTypeSymbol} {
                let sourceDelegateKinds = ImmutableArray.CreateBuilder[RefKind](sourceDelegate.Parameters.Length)
                for parameter in sourceDelegate.Parameters {
                    sourceDelegateKinds.Add(parameter.RefKind)
                }
                refKinds = sourceDelegateKinds.MoveToImmutable()
                return true
            }
            case {Type: {ClrType: sourceType is Type}} when ClrTypeUtilities.IsDelegateType(sourceType) {
                // Issue #3752: the third sibling of the same probe. A direct
                // `Invoke` reflection answers null for a delegate closed over
                // a MetadataLoadContext-projected type, which used to abandon
                // the source's ref kinds entirely.
                if ClrLoadContext.TryGetDelegateSignature(sourceType, out var sourceParameters, out _) {
                    refKinds = GetDelegateParameterRefKinds(sourceType, sourceParameters.Length, out _)
                    return true
                }
            }
            case {Type: sourceFunction is FunctionTypeSymbol} {
                let sourceFunctionKinds = ImmutableArray.CreateBuilder[RefKind](sourceFunction.Arity)
                for var i = 0; i < sourceFunction.Arity; i++ {
                    sourceFunctionKinds.Add(RefKind.None)
                }
                refKinds = sourceFunctionKinds.MoveToImmutable()
                return true
            }
        }
        refKinds = default(ImmutableArray[RefKind])
        return false
    }

    /// Issue #3752 (#3705, family 3): reads a delegate type's `Invoke`
    /// parameter ref kinds in a way that survives a cross-reflection-context
    /// closure.
    ///
    /// A native function type over a `MetadataLoadContext`-projected type
    /// (`(Type) -> Type` in any compile with `/reference:`) has a
    /// `System.Reflection.Emit.TypeBuilderInstantiation` as its CLR type,
    /// because `typeof(Func<,>).MakeGenericType` cannot produce a
    /// `RuntimeType` over foreign-context arguments. Reflecting
    /// `Invoke` off it throws (cref:NotSupportedException), so the
    /// direct probe answers `null`. Ref kinds are stable under
    /// generic substitution, so the open definition's `Invoke` — always
    /// reachable in metadata — answers the same question, exactly as
    /// (cref:ClrLoadContext.TryGetDelegateSignature) does for the
    /// parameter and return types.
    /// @param delegateType The delegate (or native function) CLR type.
    /// @param parameterCount The signature's parameter count, used when no `Invoke` is reachable at all.
    /// @param returnRefKind The `Invoke` return's ref kind.
    /// @returns One ref kind per `Invoke` parameter.
    internal func GetDelegateParameterRefKinds(
        delegateType Type?,
        parameterCount int32,
        out returnRefKind RefKind
    ) ImmutableArray[RefKind] {
        returnRefKind = RefKind.None
        let invoke MethodInfo? = delegateType?.GetMethodSafe("Invoke") ?? TryGetOpenDefinitionInvoke(delegateType)
        if invoke == nil {
            return ImmutableArray.CreateRange(Enumerable.Repeat(RefKind.None, parameterCount))
        }
        returnRefKind = RefCapabilities.GetReturnRefKind(invoke)
        return GetParameterRefKinds(invoke)
    }

    internal func GetParameterRefKinds(method MethodInfo, skipFirstParameter bool = false) ImmutableArray[RefKind] {
        let parameters = method.GetParameters()
        let offset = if skipFirstParameter {
            1
        } else {
            0
        }
        let refKinds = ImmutableArray.CreateBuilder[RefKind](parameters.Length - offset)
        for var i = offset; i < parameters.Length; i++ {
            refKinds.Add(GetParameterRefKind(parameters[i]))
        }
        return refKinds.MoveToImmutable()
    }

    private func TryGetMethodGroupParameterRefKinds(
        group BoundMethodGroupExpression,
        out refKinds ImmutableArray[RefKind]
    ) bool {
        if group.FunctionType != nil && group.Function != nil {
            refKinds = GetParameterRefKinds(group.Function, group.Receiver)
            return true
        }
        let candidateKinds = List[ImmutableArray[RefKind]](group.Candidates.Length)
        for candidate in group.Candidates {
            candidateKinds.Add(GetParameterRefKinds(candidate, group.Receiver))
        }
        return TryGetCommonParameterRefKinds(candidateKinds, out refKinds)
    }

    private func TryGetClrMethodGroupParameterRefKinds(
        group BoundClrMethodGroupExpression,
        out refKinds ImmutableArray[RefKind]
    ) bool {
        if group.ResolvedMethod != nil {
            refKinds = GetLogicalParameterRefKinds(
                group.ResolvedMethod,
                skipFirstParameter: group.Receiver != nil && group.ResolvedMethod.IsStatic
            )
            return true
        }
        let candidateKinds = List[ImmutableArray[RefKind]](group.Candidates.Length)
        for candidate in group.Candidates {
            candidateKinds.Add(
                GetLogicalParameterRefKinds(candidate, skipFirstParameter: group.Receiver != nil && candidate.IsStatic)
            )
        }
        return TryGetCommonParameterRefKinds(candidateKinds, out refKinds)
    }

    private func GetLogicalParameterRefKinds(method MethodInfo, skipFirstParameter bool) ImmutableArray[RefKind] {
        let refKinds = GetParameterRefKinds(method, skipFirstParameter)
        return if ImportedFunctionSymbol.HasHiddenContextParameter(method) {
            refKinds.RemoveAt(refKinds.Length - 1)
        } else {
            refKinds
        }
    }

    private func GetParameterRefKinds(function FunctionSymbol, receiver BoundExpression?) ImmutableArray[RefKind] {
        let parameterOffset = if function.IsExtension && receiver != nil {
            1
        } else {
            0
        }
        let refKinds = ImmutableArray.CreateBuilder[RefKind](function.Parameters.Length - parameterOffset)
        for var i = parameterOffset; i < function.Parameters.Length; i++ {
            refKinds.Add(function.Parameters[i].RefKind)
        }
        return refKinds.MoveToImmutable()
    }

    private func TryGetCommonParameterRefKinds(
        candidates IEnumerable[ImmutableArray[RefKind]],
        out refKinds ImmutableArray[RefKind]
    ) bool {
        refKinds = default(ImmutableArray[RefKind])
        for candidate in candidates {
            if refKinds.IsDefault {
                refKinds = candidate
            } else if !RefKindsEqual(refKinds, candidate) {
                refKinds = default(ImmutableArray[RefKind])
                return false
            }
        }
        return !refKinds.IsDefault
    }

    private func RefKindsEqual(left ImmutableArray[RefKind], right ImmutableArray[RefKind]) bool {
        if left.Length != right.Length {
            return false
        }
        for var i = 0; i < left.Length; i++ {
            if (left[i] != right[i]) {
                return false
            }
        }
        return true
    }

    /// Issue #3752: the open generic definition's `Invoke`, the only one
    /// reachable when the closed type is a cross-context
    /// `TypeBuilderInstantiation`.
    /// @param delegateType The closed delegate type.
    /// @returns The open definition's `Invoke`, or `null`.
    private func TryGetOpenDefinitionInvoke(delegateType Type?) MethodInfo? {
        if delegateType == nil || !delegateType.IsGenericType || delegateType.IsGenericTypeDefinition {
            return nil
        }
        try {
            return delegateType.GetGenericTypeDefinition().GetMethodSafe("Invoke")
        } catch (Exception) {
            return nil
        }
    }

    private func GetParameterRefKind(parameter ParameterInfo) RefKind -> if !parameter.ParameterType.IsByRef {
        RefKind.None
    } else {
        (
            if parameter.IsOut {
                RefKind.Out
            } else {
                (
                    if parameter.IsIn {
                        RefKind.In
                    } else {
                        RefKind.Ref
                    }
                )
            }
        )
    }
}
