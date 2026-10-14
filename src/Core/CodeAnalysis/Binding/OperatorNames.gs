// <copyright file="OperatorNames.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Syntax

/// Maps GSharp operator tokens (as written inside `func (...) operator +(...)`
/// declarations) to the corresponding CLR `op_*` method name. Stream D —
/// user-defined operator overloads on GSharp types.
internal shared class OperatorNames {
    /// Returns the CLR `op_*` name for a binary operator token, or
    /// `null` if the token is not a supported binary operator.
    /// @param kind The operator token kind.
    /// @returns The CLR operator name, or `null`.
    func TryGetBinaryName(kind SyntaxKind) string? {
        return switch kind {
            case SyntaxKind.PlusToken: "op_Addition"
            case SyntaxKind.MinusToken: "op_Subtraction"
            case SyntaxKind.StarToken: "op_Multiply"
            case SyntaxKind.SlashToken: "op_Division"
            case SyntaxKind.PercentToken: "op_Modulus"
            case SyntaxKind.AmpersandToken: "op_BitwiseAnd"
            case SyntaxKind.PipeToken: "op_BitwiseOr"
            case SyntaxKind.HatToken: "op_ExclusiveOr"
            case SyntaxKind.ShiftLeftToken: "op_LeftShift"
            case SyntaxKind.ShiftRightToken: "op_RightShift"
            case SyntaxKind.UnsignedShiftRightToken: "op_UnsignedRightShift"
            case SyntaxKind.EqualsEqualsToken: "op_Equality"
            case SyntaxKind.BangEqualsToken: "op_Inequality"
            case SyntaxKind.LessToken: "op_LessThan"
            case SyntaxKind.LessOrEqualsToken: "op_LessThanOrEqual"
            case SyntaxKind.GreaterToken: "op_GreaterThan"
            case SyntaxKind.GreaterOrEqualsToken: "op_GreaterThanOrEqual"
            default: default(string?)
        }
    }

    /// Returns the CLR `op_*` name for a unary operator token, or
    /// `null` if the token is not a supported unary operator.
    /// @param kind The operator token kind.
    /// @returns The CLR operator name, or `null`.
    func TryGetUnaryName(kind SyntaxKind) string? {
        return switch kind {
            case SyntaxKind.PlusToken: "op_UnaryPlus"
            case SyntaxKind.MinusToken: "op_UnaryNegation"
            case SyntaxKind.BangToken: "op_LogicalNot"
            case SyntaxKind.TildeToken: "op_OnesComplement"
            default: default(string?)
        }
    }

    /// Returns the CLR `op_*Assignment` name for a compound-assignment
    /// operator token, or `null` if the token is not a
    /// supported compound-assignment operator (issue #2834 / ADR-0035).
    /// @remarks These are the metadata names C# 14 uses for user-defined compound
    /// assignment, so a G# `func (b Bag) operator +=(n int32)` and a C#
    /// `public void operator +=(int n)` produce the same member and
    /// interoperate in both directions. The declaration is an INSTANCE,
    /// `void`-returning method taking exactly the right-hand operand; it
    /// mutates the receiver in place rather than returning a new value.
    /// @param kind The operator token kind.
    /// @returns The CLR operator name, or `null`.
    func TryGetCompoundAssignmentName(kind SyntaxKind) string? {
        return switch kind {
            case SyntaxKind.PlusEqualsToken: "op_AdditionAssignment"
            case SyntaxKind.MinusEqualsToken: "op_SubtractionAssignment"
            case SyntaxKind.StarEqualsToken: "op_MultiplicationAssignment"
            case SyntaxKind.SlashEqualsToken: "op_DivisionAssignment"
            case SyntaxKind.PercentEqualsToken: "op_ModulusAssignment"
            case SyntaxKind.AmpersandEqualsToken: "op_BitwiseAndAssignment"
            case SyntaxKind.PipeEqualsToken: "op_BitwiseOrAssignment"
            case SyntaxKind.HatEqualsToken: "op_ExclusiveOrAssignment"
            case SyntaxKind.ShiftLeftEqualsToken: "op_LeftShiftAssignment"
            case SyntaxKind.ShiftRightEqualsToken: "op_RightShiftAssignment"
            case SyntaxKind.UnsignedShiftRightEqualsToken: "op_UnsignedRightShiftAssignment"
            default: default(string?)
        }
    }

    /// Indicates whether [`name`](paramref) is one of the CLR
    /// compound-assignment operator names produced by
    /// (cref:TryGetCompoundAssignmentName).
    /// @param name The candidate CLR method name.
    /// @returns `true` for a compound-assignment operator name.
    func IsCompoundAssignmentName(name string) bool {
        return switch name {
            case "op_AdditionAssignment": true
            case "op_SubtractionAssignment": true
            case "op_MultiplicationAssignment": true
            case "op_DivisionAssignment": true
            case "op_ModulusAssignment": true
            case "op_BitwiseAndAssignment": true
            case "op_BitwiseOrAssignment": true
            case "op_ExclusiveOrAssignment": true
            case "op_LeftShiftAssignment": true
            case "op_RightShiftAssignment": true
            case "op_UnsignedRightShiftAssignment": true
            default: false
        }
    }
}
