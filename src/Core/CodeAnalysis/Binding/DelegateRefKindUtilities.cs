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
                var sourceDelegateKinds = ImmutableArray.CreateBuilder<RefKind>(sourceDelegate.Parameters.Length);
                foreach (var parameter in sourceDelegate.Parameters)
                {
                    sourceDelegateKinds.Add(parameter.RefKind);
                }

                refKinds = sourceDelegateKinds.MoveToImmutable();
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
                var sourceFunctionKinds = ImmutableArray.CreateBuilder<RefKind>(sourceFunction.Arity);
                for (var i = 0; i < sourceFunction.Arity; i++)
                {
                    sourceFunctionKinds.Add(RefKind.None);
                }

                refKinds = sourceFunctionKinds.MoveToImmutable();
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
        var offset = skipFirstParameter ? 1 : 0;
        var refKinds = ImmutableArray.CreateBuilder<RefKind>(parameters.Length - offset);
        for (var i = offset; i < parameters.Length; i++)
        {
            refKinds.Add(GetParameterRefKind(parameters[i]));
        }

        return refKinds.MoveToImmutable();
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

        var candidateKinds = new List<ImmutableArray<RefKind>>(group.Candidates.Length);
        foreach (var candidate in group.Candidates)
        {
            candidateKinds.Add(GetParameterRefKinds(candidate, group.Receiver));
        }

        return TryGetCommonParameterRefKinds(candidateKinds, out refKinds);
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

        var candidateKinds = new List<ImmutableArray<RefKind>>(group.Candidates.Length);
        foreach (var candidate in group.Candidates)
        {
            candidateKinds.Add(GetParameterRefKinds(
                candidate,
                skipFirstParameter: group.Receiver != null && candidate.IsStatic));
        }

        return TryGetCommonParameterRefKinds(candidateKinds, out refKinds);
    }

    private static ImmutableArray<RefKind> GetParameterRefKinds(
        FunctionSymbol function,
        BoundExpression? receiver)
    {
        var parameterOffset = function.IsExtension && receiver != null ? 1 : 0;
        var refKinds = ImmutableArray.CreateBuilder<RefKind>(function.Parameters.Length - parameterOffset);
        for (var i = parameterOffset; i < function.Parameters.Length; i++)
        {
            refKinds.Add(function.Parameters[i].RefKind);
        }

        return refKinds.MoveToImmutable();
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
            else if (!RefKindsEqual(refKinds, candidate))
            {
                refKinds = default;
                return false;
            }
        }

        return !refKinds.IsDefault;
    }

    private static bool RefKindsEqual(ImmutableArray<RefKind> left, ImmutableArray<RefKind> right)
    {
        if (left.Length != right.Length)
        {
            return false;
        }

        for (var i = 0; i < left.Length; i++)
        {
            if (left[i] != right[i])
            {
                return false;
            }
        }

        return true;
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
