// <copyright file="DelegateRefKindUtilities.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

internal static class DelegateRefKindUtilities
{
    internal static bool TryGetSourceParameterRefKinds(
        BoundExpression expression,
        out ImmutableArray<RefKind> refKinds)
    {
        while (expression is BoundConversionExpression conversion)
        {
            expression = conversion.Expression;
        }

        switch (expression)
        {
            case BoundFunctionLiteralExpression literal:
                refKinds = GetParameterRefKinds(literal.Function, receiver: null);
                return true;
            case BoundMethodGroupExpression group:
                return TryGetMethodGroupParameterRefKinds(group, out refKinds);
            case BoundClrMethodGroupExpression group:
                return TryGetClrMethodGroupParameterRefKinds(group, out refKinds);
            case { Type: DelegateTypeSymbol sourceDelegate }:
                refKinds = sourceDelegate.Parameters
                    .Select(parameter => parameter.RefKind)
                    .ToImmutableArray();
                return true;
            case { Type.ClrType: System.Type sourceType }
                when ClrTypeUtilities.IsDelegateType(sourceType):
                var sourceInvoke = sourceType.GetMethodSafe("Invoke");
                if (sourceInvoke != null)
                {
                    refKinds = GetParameterRefKinds(sourceInvoke);
                    return true;
                }

                break;
            case { Type: FunctionTypeSymbol sourceFunction }:
                refKinds = ImmutableArray.CreateRange(
                    Enumerable.Repeat(RefKind.None, sourceFunction.Arity));
                return true;
        }

        refKinds = default;
        return false;
    }

    internal static ImmutableArray<RefKind> GetParameterRefKinds(
        MethodInfo method,
        bool skipFirstParameter = false)
    {
        var parameters = method.GetParameters();
        return parameters
            .Skip(skipFirstParameter ? 1 : 0)
            .Select(GetParameterRefKind)
            .ToImmutableArray();
    }

    private static bool TryGetMethodGroupParameterRefKinds(
        BoundMethodGroupExpression group,
        out ImmutableArray<RefKind> refKinds)
    {
        if (group.FunctionType != null && group.Function != null)
        {
            refKinds = GetParameterRefKinds(group.Function, group.Receiver);
            return true;
        }

        return TryGetCommonParameterRefKinds(
            group.Candidates.Select(candidate => GetParameterRefKinds(candidate, group.Receiver)),
            out refKinds);
    }

    private static bool TryGetClrMethodGroupParameterRefKinds(
        BoundClrMethodGroupExpression group,
        out ImmutableArray<RefKind> refKinds)
    {
        if (group.ResolvedMethod != null)
        {
            refKinds = GetParameterRefKinds(
                group.ResolvedMethod,
                skipFirstParameter: group.Receiver != null && group.ResolvedMethod.IsStatic);
            return true;
        }

        return TryGetCommonParameterRefKinds(
            group.Candidates.Select(candidate => GetParameterRefKinds(
                candidate,
                skipFirstParameter: group.Receiver != null && candidate.IsStatic)),
            out refKinds);
    }

    private static ImmutableArray<RefKind> GetParameterRefKinds(
        FunctionSymbol function,
        BoundExpression? receiver)
    {
        var parameterOffset = function.IsExtension && receiver != null ? 1 : 0;
        return function.Parameters
            .Skip(parameterOffset)
            .Select(parameter => parameter.RefKind)
            .ToImmutableArray();
    }

    private static bool TryGetCommonParameterRefKinds(
        IEnumerable<ImmutableArray<RefKind>> candidates,
        out ImmutableArray<RefKind> refKinds)
    {
        refKinds = default;
        foreach (var candidate in candidates)
        {
            if (refKinds.IsDefault)
            {
                refKinds = candidate;
            }
            else if (!refKinds.SequenceEqual(candidate))
            {
                refKinds = default;
                return false;
            }
        }

        return !refKinds.IsDefault;
    }

    private static RefKind GetParameterRefKind(ParameterInfo parameter) =>
        !parameter.ParameterType.IsByRef
            ? RefKind.None
            : parameter.IsOut
                ? RefKind.Out
                : parameter.IsIn
                    ? RefKind.In
                    : RefKind.Ref;
}
