// <copyright file="OperatorNames.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Maps GSharp operator tokens (as written inside <c>func (...) operator +(...)</c>
/// declarations) to the corresponding CLR <c>op_*</c> method name. Stream D —
/// user-defined operator overloads on GSharp types.
/// </summary>
internal static class OperatorNames
{
    /// <summary>
    /// Returns the CLR <c>op_*</c> name for a binary operator token, or
    /// <see langword="null"/> if the token is not a supported binary operator.
    /// </summary>
    /// <param name="kind">The operator token kind.</param>
    /// <returns>The CLR operator name, or <see langword="null"/>.</returns>
    public static string TryGetBinaryName(SyntaxKind kind)
    {
        return kind switch
        {
            SyntaxKind.PlusToken => "op_Addition",
            SyntaxKind.MinusToken => "op_Subtraction",
            SyntaxKind.StarToken => "op_Multiply",
            SyntaxKind.SlashToken => "op_Division",
            SyntaxKind.PercentToken => "op_Modulus",
            SyntaxKind.AmpersandToken => "op_BitwiseAnd",
            SyntaxKind.PipeToken => "op_BitwiseOr",
            SyntaxKind.HatToken => "op_ExclusiveOr",
            SyntaxKind.ShiftLeftToken => "op_LeftShift",
            SyntaxKind.ShiftRightToken => "op_RightShift",
            SyntaxKind.UnsignedShiftRightToken => "op_UnsignedRightShift",
            SyntaxKind.EqualsEqualsToken => "op_Equality",
            SyntaxKind.BangEqualsToken => "op_Inequality",
            SyntaxKind.LessToken => "op_LessThan",
            SyntaxKind.LessOrEqualsToken => "op_LessThanOrEqual",
            SyntaxKind.GreaterToken => "op_GreaterThan",
            SyntaxKind.GreaterOrEqualsToken => "op_GreaterThanOrEqual",
            _ => null,
        };
    }

    /// <summary>
    /// Returns the CLR <c>op_*</c> name for a unary operator token, or
    /// <see langword="null"/> if the token is not a supported unary operator.
    /// </summary>
    /// <param name="kind">The operator token kind.</param>
    /// <returns>The CLR operator name, or <see langword="null"/>.</returns>
    public static string TryGetUnaryName(SyntaxKind kind)
    {
        return kind switch
        {
            SyntaxKind.PlusToken => "op_UnaryPlus",
            SyntaxKind.MinusToken => "op_UnaryNegation",
            SyntaxKind.BangToken => "op_LogicalNot",
            SyntaxKind.HatToken => "op_OnesComplement",
            _ => null,
        };
    }
}
