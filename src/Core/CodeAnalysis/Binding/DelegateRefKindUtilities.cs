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

                // Issue #3752: the third sibling of the same probe. A direct
                // `Invoke` reflection answers null for a delegate closed over
                // a MetadataLoadContext-projected type, which used to abandon
                // the source's ref kinds entirely.
                if (ClrLoadContext.TryGetDelegateSignature(sourceType, out var sourceParameters, out _))
                {
                    refKinds = GetDelegateParameterRefKinds(sourceType, sourceParameters.Length, out _);
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

    /// <summary>
    /// Issue #3752 (#3705, family 3): reads a delegate type's <c>Invoke</c>
    /// parameter ref kinds in a way that survives a cross-reflection-context
    /// closure.
    /// <para>
    /// A native function type over a <c>MetadataLoadContext</c>-projected type
    /// (<c>(Type) -&gt; Type</c> in any compile with <c>/reference:</c>) has a
    /// <c>System.Reflection.Emit.TypeBuilderInstantiation</c> as its CLR type,
    /// because <c>typeof(Func&lt;,&gt;).MakeGenericType</c> cannot produce a
    /// <c>RuntimeType</c> over foreign-context arguments. Reflecting
    /// <c>Invoke</c> off it throws <see cref="NotSupportedException"/>, so the
    /// direct probe answers <see langword="null"/>. Ref kinds are stable under
    /// generic substitution, so the open definition's <c>Invoke</c> — always
    /// reachable in metadata — answers the same question, exactly as
    /// <see cref="ClrLoadContext.TryGetDelegateSignature"/> does for the
    /// parameter and return types.
    /// </para>
    /// </summary>
    /// <param name="delegateType">The delegate (or native function) CLR type.</param>
    /// <param name="parameterCount">The signature's parameter count, used when no <c>Invoke</c> is reachable at all.</param>
    /// <param name="returnRefKind">The <c>Invoke</c> return's ref kind.</param>
    /// <returns>One ref kind per <c>Invoke</c> parameter.</returns>
    internal static ImmutableArray<RefKind> GetDelegateParameterRefKinds(
        System.Type? delegateType,
        int parameterCount,
        out RefKind returnRefKind)
    {
        returnRefKind = RefKind.None;
        var invoke = delegateType?.GetMethodSafe("Invoke") ?? TryGetOpenDefinitionInvoke(delegateType);
        if (invoke == null)
        {
            return ImmutableArray.CreateRange(Enumerable.Repeat(RefKind.None, parameterCount));
        }

        returnRefKind = invoke.ReturnType.IsByRef ? RefKind.Ref : RefKind.None;
        return GetParameterRefKinds(invoke);
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

    /// <summary>
    /// Issue #3752: the open generic definition's <c>Invoke</c>, the only one
    /// reachable when the closed type is a cross-context
    /// <c>TypeBuilderInstantiation</c>.
    /// </summary>
    /// <param name="delegateType">The closed delegate type.</param>
    /// <returns>The open definition's <c>Invoke</c>, or <see langword="null"/>.</returns>
    private static MethodInfo? TryGetOpenDefinitionInvoke(System.Type? delegateType)
    {
        if (delegateType is null || !delegateType.IsGenericType || delegateType.IsGenericTypeDefinition)
        {
            return null;
        }

        try
        {
            return delegateType.GetGenericTypeDefinition().GetMethodSafe("Invoke");
        }
        catch (System.Exception)
        {
            return null;
        }
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
