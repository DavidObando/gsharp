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

    /// <summary>
    /// Returns the CLR <c>op_*Assignment</c> name for a compound-assignment
    /// operator token, or <see langword="null"/> if the token is not a
    /// supported compound-assignment operator (issue #2834 / ADR-0035).
    /// </summary>
    /// <remarks>
    /// These are the metadata names C# 14 uses for user-defined compound
    /// assignment, so a G# <c>func (b Bag) operator +=(n int32)</c> and a C#
    /// <c>public void operator +=(int n)</c> produce the same member and
    /// interoperate in both directions. The declaration is an INSTANCE,
    /// <c>void</c>-returning method taking exactly the right-hand operand; it
    /// mutates the receiver in place rather than returning a new value.
    /// </remarks>
    /// <param name="kind">The operator token kind.</param>
    /// <returns>The CLR operator name, or <see langword="null"/>.</returns>
    public static string TryGetCompoundAssignmentName(SyntaxKind kind)
    {
        return kind switch
        {
            SyntaxKind.PlusEqualsToken => "op_AdditionAssignment",
            SyntaxKind.MinusEqualsToken => "op_SubtractionAssignment",
            SyntaxKind.StarEqualsToken => "op_MultiplicationAssignment",
            SyntaxKind.SlashEqualsToken => "op_DivisionAssignment",
            SyntaxKind.PercentEqualsToken => "op_ModulusAssignment",
            SyntaxKind.AmpersandEqualsToken => "op_BitwiseAndAssignment",
            SyntaxKind.PipeEqualsToken => "op_BitwiseOrAssignment",
            SyntaxKind.HatEqualsToken => "op_ExclusiveOrAssignment",
            SyntaxKind.ShiftLeftEqualsToken => "op_LeftShiftAssignment",
            SyntaxKind.ShiftRightEqualsToken => "op_RightShiftAssignment",
            SyntaxKind.UnsignedShiftRightEqualsToken => "op_UnsignedRightShiftAssignment",
            _ => null,
        };
    }

    /// <summary>
    /// Indicates whether <paramref name="name"/> is one of the CLR
    /// compound-assignment operator names produced by
    /// <see cref="TryGetCompoundAssignmentName"/>.
    /// </summary>
    /// <param name="name">The candidate CLR method name.</param>
    /// <returns><see langword="true"/> for a compound-assignment operator name.</returns>
    public static bool IsCompoundAssignmentName(string name)
    {
        return name switch
        {
            "op_AdditionAssignment" => true,
            "op_SubtractionAssignment" => true,
            "op_MultiplicationAssignment" => true,
            "op_DivisionAssignment" => true,
            "op_ModulusAssignment" => true,
            "op_BitwiseAndAssignment" => true,
            "op_BitwiseOrAssignment" => true,
            "op_ExclusiveOrAssignment" => true,
            "op_LeftShiftAssignment" => true,
            "op_RightShiftAssignment" => true,
            "op_UnsignedRightShiftAssignment" => true,
            _ => false,
        };
    }
}
