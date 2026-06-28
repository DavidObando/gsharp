#nullable disable

// <copyright file="ClrOperatorResolution.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Stream C helper: resolves binary and unary operator <see cref="SyntaxKind"/>
/// values to CLR operator method names (<c>op_Addition</c>, <c>op_Equality</c>,
/// <c>op_UnaryNegation</c>, ...) and performs the actual public-static lookup
/// across the two operand types. The "better function member" tie-break is
/// delegated to <see cref="OverloadResolution.Resolve{T}"/> so user-defined
/// operators participate in the same conversion ranking as method calls and
/// constructors (Stream A).
/// </summary>
internal static class ClrOperatorResolution
{
    private static readonly Dictionary<SyntaxKind, string> BinaryNames = new()
    {
        [SyntaxKind.PlusToken] = "op_Addition",
        [SyntaxKind.MinusToken] = "op_Subtraction",
        [SyntaxKind.StarToken] = "op_Multiply",
        [SyntaxKind.SlashToken] = "op_Division",
        [SyntaxKind.PercentToken] = "op_Modulus",
        [SyntaxKind.AmpersandToken] = "op_BitwiseAnd",
        [SyntaxKind.PipeToken] = "op_BitwiseOr",
        [SyntaxKind.HatToken] = "op_ExclusiveOr",
        [SyntaxKind.ShiftLeftToken] = "op_LeftShift",
        [SyntaxKind.ShiftRightToken] = "op_RightShift",
        [SyntaxKind.EqualsEqualsToken] = "op_Equality",
        [SyntaxKind.BangEqualsToken] = "op_Inequality",
        [SyntaxKind.LessToken] = "op_LessThan",
        [SyntaxKind.LessOrEqualsToken] = "op_LessThanOrEqual",
        [SyntaxKind.GreaterToken] = "op_GreaterThan",
        [SyntaxKind.GreaterOrEqualsToken] = "op_GreaterThanOrEqual",
    };

    private static readonly Dictionary<SyntaxKind, string> UnaryNames = new()
    {
        [SyntaxKind.PlusToken] = "op_UnaryPlus",
        [SyntaxKind.MinusToken] = "op_UnaryNegation",
        [SyntaxKind.BangToken] = "op_LogicalNot",
        [SyntaxKind.HatToken] = "op_OnesComplement",
    };

    /// <summary>Looks up the CLR operator name for a binary operator token.</summary>
    /// <param name="kind">The operator syntax kind.</param>
    /// <returns>The CLR method name (e.g. <c>op_Addition</c>) or <see langword="null"/>.</returns>
    public static string TryGetBinaryName(SyntaxKind kind)
        => BinaryNames.TryGetValue(kind, out var name) ? name : null;

    /// <summary>Looks up the CLR operator name for a unary operator token.</summary>
    /// <param name="kind">The operator syntax kind.</param>
    /// <returns>The CLR method name (e.g. <c>op_UnaryNegation</c>) or <see langword="null"/>.</returns>
    public static string TryGetUnaryName(SyntaxKind kind)
        => UnaryNames.TryGetValue(kind, out var name) ? name : null;

    /// <summary>Resolves a binary operator overload on the union of operand types.</summary>
    /// <param name="kind">The operator token.</param>
    /// <param name="leftType">The left operand's GSharp type.</param>
    /// <param name="rightType">The right operand's GSharp type.</param>
    /// <param name="method">The resolved method on success.</param>
    /// <param name="isAmbiguous">Whether multiple candidates were equally good.</param>
    /// <returns><see langword="true"/> if a unique operator was found.</returns>
    public static bool TryResolveBinary(SyntaxKind kind, TypeSymbol leftType, TypeSymbol rightType, out MethodInfo method, out bool isAmbiguous)
    {
        method = null;
        isAmbiguous = false;
        var name = TryGetBinaryName(kind);
        if (name == null)
        {
            return false;
        }

        var candidates = new List<MethodInfo>();
        CollectOperators(leftType?.ClrType, name, candidates);
        CollectOperators(rightType?.ClrType, name, candidates);
        if (candidates.Count == 0)
        {
            return false;
        }

        var argTypes = new[] { leftType?.ClrType, rightType?.ClrType };
        var outcome = OverloadResolution.Resolve(candidates, argTypes);
        if (outcome.Outcome == OverloadResolution.ResolutionOutcome.Resolved)
        {
            method = outcome.Best;
            return true;
        }

        if (outcome.Outcome == OverloadResolution.ResolutionOutcome.Ambiguous)
        {
            isAmbiguous = true;
        }

        return false;
    }

    /// <summary>Resolves a unary operator overload on an operand type.</summary>
    /// <param name="kind">The operator token.</param>
    /// <param name="operandType">The operand's GSharp type.</param>
    /// <param name="method">The resolved method on success.</param>
    /// <param name="isAmbiguous">Whether multiple candidates were equally good.</param>
    /// <returns><see langword="true"/> if a unique operator was found.</returns>
    public static bool TryResolveUnary(SyntaxKind kind, TypeSymbol operandType, out MethodInfo method, out bool isAmbiguous)
    {
        method = null;
        isAmbiguous = false;
        var name = TryGetUnaryName(kind);
        if (name == null || operandType?.ClrType == null)
        {
            return false;
        }

        var candidates = new List<MethodInfo>();
        CollectOperators(operandType.ClrType, name, candidates);
        if (candidates.Count == 0)
        {
            return false;
        }

        var argTypes = new[] { operandType.ClrType };
        var outcome = OverloadResolution.Resolve(candidates, argTypes);
        if (outcome.Outcome == OverloadResolution.ResolutionOutcome.Resolved)
        {
            method = outcome.Best;
            return true;
        }

        if (outcome.Outcome == OverloadResolution.ResolutionOutcome.Ambiguous)
        {
            isAmbiguous = true;
        }

        return false;
    }

    private static void CollectOperators(Type type, string name, List<MethodInfo> sink)
    {
        if (type == null)
        {
            return;
        }

        for (var t = type; t != null; t = SafeBaseType(t))
        {
            MethodInfo[] candidates;
            try
            {
                candidates = t.GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly);
            }
            catch
            {
                break;
            }

            foreach (var m in candidates)
            {
                if (!m.IsSpecialName || !string.Equals(m.Name, name, StringComparison.Ordinal))
                {
                    continue;
                }

                if (!ContainsByIdentity(sink, m))
                {
                    sink.Add(m);
                }
            }
        }
    }

    private static bool ContainsByIdentity(List<MethodInfo> sink, MethodInfo candidate)
    {
        // De-dup by declaring-type + signature so the cross-reflection-context
        // safe collector doesn't add the same operator twice when both operand
        // types funnel through the same chain (`TimeSpan + TimeSpan`).
        var candidateParams = candidate.GetParameters();
        foreach (var existing in sink)
        {
            if (!string.Equals(existing.Name, candidate.Name, StringComparison.Ordinal))
            {
                continue;
            }

            if (!ClrTypeUtilities.AreSame(existing.DeclaringType, candidate.DeclaringType))
            {
                continue;
            }

            var existingParams = existing.GetParameters();
            if (existingParams.Length != candidateParams.Length)
            {
                continue;
            }

            var same = true;
            for (var i = 0; i < existingParams.Length; i++)
            {
                if (!ClrTypeUtilities.AreSame(existingParams[i].ParameterType, candidateParams[i].ParameterType))
                {
                    same = false;
                    break;
                }
            }

            if (same)
            {
                return true;
            }
        }

        return false;
    }

    private static Type SafeBaseType(Type t)
    {
        try
        {
            return t.BaseType;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Resolves a user-defined conversion (<c>op_Implicit</c> and optionally
    /// <c>op_Explicit</c>) from <paramref name="sourceType"/> to
    /// <paramref name="targetType"/>. Searches both the source and target
    /// declaring types as C# does, with implicits preferred over explicits.
    /// </summary>
    /// <param name="sourceType">CLR type of the value being converted.</param>
    /// <param name="targetType">CLR type the value is being converted to.</param>
    /// <param name="allowExplicit">Whether <c>op_Explicit</c> is acceptable.</param>
    /// <param name="method">The resolved conversion method on success.</param>
    /// <param name="isExplicit">Whether the resolved method is an explicit conversion.</param>
    /// <returns><see langword="true"/> if a conversion was found.</returns>
#pragma warning disable SA1202
    public static bool TryResolveConversion(Type sourceType, Type targetType, bool allowExplicit, out MethodInfo method, out bool isExplicit)
#pragma warning restore SA1202
    {
        method = null;
        isExplicit = false;
        if (sourceType == null || targetType == null)
        {
            return false;
        }

        // Pass 1: implicits on source then target.
        if (TryFind(sourceType, "op_Implicit", sourceType, targetType, out method)
            || TryFind(targetType, "op_Implicit", sourceType, targetType, out method))
        {
            return true;
        }

        if (!allowExplicit)
        {
            return false;
        }

        // Pass 2: explicits on source then target.
        if (TryFind(sourceType, "op_Explicit", sourceType, targetType, out method)
            || TryFind(targetType, "op_Explicit", sourceType, targetType, out method))
        {
            isExplicit = true;
            return true;
        }

        return false;
    }

    private static bool TryFind(Type declaring, string name, Type src, Type tgt, out MethodInfo method)
    {
        method = null;
        if (declaring == null)
        {
            return false;
        }

        MethodInfo[] candidates;
        try
        {
            candidates = declaring.GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly);
        }
        catch
        {
            return false;
        }

        foreach (var m in candidates)
        {
            if (!m.IsSpecialName || !string.Equals(m.Name, name, StringComparison.Ordinal))
            {
                continue;
            }

            var ps = m.GetParameters();
            if (ps.Length != 1)
            {
                continue;
            }

            if (ClrTypeUtilities.AreSame(ps[0].ParameterType, src) && ClrTypeUtilities.AreSame(m.ReturnType, tgt))
            {
                method = m;
                return true;
            }
        }

        return false;
    }
}
