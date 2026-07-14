// <copyright file="EnumOperatorTable.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Single declarative source for every C# §11.10 enum operator rule.
/// Adding a new operator group is a one-row change in this table — no new arm
/// in BoundBinaryOperator.cs or BoundUnaryOperator.cs.
/// </summary>
/// <remarks>
/// Issues #534 (bitwise), #574 (comparison), and bug-overview item 6.6
/// (architectural unification + §11.10 arithmetic gaps) are all serviced
/// through this table. The emit-side signed-vs-unsigned dispatch
/// (<see cref="IsUnsignedEnumUnderlying"/>) is also co-located here so the
/// connection between "binder accepted enum1 &lt; enum2" and "emitter chose
/// clt_un" lives in one place.
///
/// <para><strong>Why this pattern is NOT extended to user-defined operators
/// (issue #613 investigation):</strong> The <c>EnumOperatorTable</c> is a
/// closed-world static ruleset — all enums share the same §11.10 operator set,
/// so a declarative dictionary is ideal. User-defined operators (Streams C
/// and D) are open-world dynamic dispatch: each type declares its own operator
/// set via CLR <c>op_*</c> methods or GSharp receiver-form <c>operator</c>
/// declarations. They resolve through method lookup (reflection for imported
/// CLR types in <see cref="ClrOperatorResolution"/>; symbol-table lookup for
/// GSharp types via <c>StructSymbol.TryGetMethodIncludingInherited</c>), not
/// through type-shape predicate matching. Both paths are already centralized
/// at single call sites in <c>ExpressionBinder.Operators.cs</c> and produce
/// different bound node types (<c>BoundCallExpression</c> /
/// <c>BoundClrBinaryOperatorExpression</c>) than the built-in operators this
/// table feeds. A shared base class or generic <c>OperatorLiftTable</c> would
/// add abstraction without reducing duplication, since no duplication exists
/// to consolidate.</para>
/// </remarks>
internal static class EnumOperatorTable
{
    private static readonly Dictionary<SyntaxKind, BinaryRule[]> BinaryRules = new()
    {
        // Comparison: enum == enum → bool (post-#574)
        [SyntaxKind.EqualsEqualsToken] = new[] { new BinaryRule(BoundBinaryOperatorKind.Equals, OperandShape.EnumEnum, ResultRule.ResultBool) },
        [SyntaxKind.BangEqualsToken] = new[] { new BinaryRule(BoundBinaryOperatorKind.NotEquals, OperandShape.EnumEnum, ResultRule.ResultBool) },
        [SyntaxKind.LessToken] = new[] { new BinaryRule(BoundBinaryOperatorKind.Less, OperandShape.EnumEnum, ResultRule.ResultBool) },
        [SyntaxKind.LessOrEqualsToken] = new[] { new BinaryRule(BoundBinaryOperatorKind.LessOrEquals, OperandShape.EnumEnum, ResultRule.ResultBool) },
        [SyntaxKind.GreaterToken] = new[] { new BinaryRule(BoundBinaryOperatorKind.Greater, OperandShape.EnumEnum, ResultRule.ResultBool) },
        [SyntaxKind.GreaterOrEqualsToken] = new[] { new BinaryRule(BoundBinaryOperatorKind.GreaterOrEquals, OperandShape.EnumEnum, ResultRule.ResultBool) },

        // Bitwise: enum op enum → enum (post-#534)
        [SyntaxKind.PipeToken] = new[] { new BinaryRule(BoundBinaryOperatorKind.BitwiseOr, OperandShape.EnumEnum, ResultRule.ResultEnum) },
        [SyntaxKind.AmpersandToken] = new[] { new BinaryRule(BoundBinaryOperatorKind.BitwiseAnd, OperandShape.EnumEnum, ResultRule.ResultEnum) },
        [SyntaxKind.HatToken] = new[] { new BinaryRule(BoundBinaryOperatorKind.BitwiseXor, OperandShape.EnumEnum, ResultRule.ResultEnum) },

        // Arithmetic: §11.10 enum ± underlying and enum - enum (NEW in 6.6)
        [SyntaxKind.PlusToken] = new[]
        {
            new BinaryRule(BoundBinaryOperatorKind.Sum, OperandShape.EnumUnderlying, ResultRule.ResultEnum),
            new BinaryRule(BoundBinaryOperatorKind.Sum, OperandShape.UnderlyingEnum, ResultRule.ResultEnum),
        },
        [SyntaxKind.MinusToken] = new[]
        {
            new BinaryRule(BoundBinaryOperatorKind.Difference, OperandShape.EnumUnderlying, ResultRule.ResultEnum),
            new BinaryRule(BoundBinaryOperatorKind.Difference, OperandShape.EnumEnum, ResultRule.ResultUnderlying),
        },
    };

    private enum OperandShape
    {
        /// <summary>Both operands are the SAME enum type.</summary>
        EnumEnum,

        /// <summary>Left is enum, right is the enum's CLR underlying primitive.</summary>
        EnumUnderlying,

        /// <summary>Left is the enum's CLR underlying primitive, right is enum.</summary>
        UnderlyingEnum,
    }

    private enum ResultRule
    {
        /// <summary>Result type equals the enum operand's type.</summary>
        ResultEnum,

        /// <summary>Result type equals the enum's CLR underlying primitive.</summary>
        ResultUnderlying,

        /// <summary>Result type is bool.</summary>
        ResultBool,
    }

    /// <summary>
    /// Attempts to bind a binary operator for enum operands per C# §11.10.
    /// </summary>
    /// <param name="syntaxKind">The binary operator token kind.</param>
    /// <param name="leftType">The left operand type.</param>
    /// <param name="rightType">The right operand type.</param>
    /// <param name="kind">The resulting bound operator kind, if matched.</param>
    /// <param name="resultType">The resulting type symbol, if matched.</param>
    /// <returns><c>true</c> if the table contains a matching rule.</returns>
    public static bool TryBindBinary(
        SyntaxKind syntaxKind,
        TypeSymbol leftType,
        TypeSymbol rightType,
        out BoundBinaryOperatorKind kind,
        out TypeSymbol resultType)
    {
        kind = default;
        resultType = null;

        if (leftType == null || rightType == null)
        {
            return false;
        }

        if (!BinaryRules.TryGetValue(syntaxKind, out var rules))
        {
            return false;
        }

        foreach (var rule in rules)
        {
            if (TryMatchBinaryShape(rule.Shape, leftType, rightType, out var enumType, out var underlyingType))
            {
                kind = rule.Kind;
                resultType = rule.Result switch
                {
                    ResultRule.ResultBool => TypeSymbol.Bool,
                    ResultRule.ResultEnum => enumType,
                    ResultRule.ResultUnderlying => underlyingType,
                    _ => throw new InvalidOperationException($"Unknown result rule: {rule.Result}"),
                };
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Attempts to bind a unary operator for an enum operand per C# §11.10.
    /// Currently only ones-complement (~) is supported; unary minus is
    /// intentionally excluded per §11.10.
    /// </summary>
    /// <param name="syntaxKind">The unary operator token kind.</param>
    /// <param name="operandType">The operand type.</param>
    /// <param name="kind">The resulting bound operator kind, if matched.</param>
    /// <param name="resultType">The resulting type symbol, if matched.</param>
    /// <returns><c>true</c> if the table contains a matching rule.</returns>
    public static bool TryBindUnary(
        SyntaxKind syntaxKind,
        TypeSymbol operandType,
        out BoundUnaryOperatorKind kind,
        out TypeSymbol resultType)
    {
        kind = default;
        resultType = null;

        if (syntaxKind == SyntaxKind.HatToken && IsEnumType(operandType))
        {
            kind = BoundUnaryOperatorKind.OnesComplement;
            resultType = operandType;
            return true;
        }

        return false;
    }

    /// <summary>
    /// Returns <c>true</c> when the given type is an enum with an unsigned
    /// CLR underlying type (byte, ushort, uint, ulong). Used by the emitter's
    /// <c>IsUnsignedOrChar</c> for signed-vs-unsigned IL opcode selection.
    /// </summary>
    /// <param name="type">The type to check.</param>
    /// <returns><c>true</c> if <paramref name="type"/> is an enum with an unsigned underlying type.</returns>
    public static bool IsUnsignedEnumUnderlying(TypeSymbol type)
    {
        if (type == null)
        {
            return false;
        }

        if (type is EnumSymbol)
        {
            return false;
        }

        // Issue #2327: `type.ClrType` may be a
        // System.Reflection.Emit.TypeBuilderInstantiation — e.g. a
        // compiler-synthesized structural function-type delegate closed
        // over an in-flight TypeBuilder definition — whose `IsEnum` throws
        // NotSupportedException. Route through the shared safe helper
        // (generalizing the #1100/#2135 pattern) instead of probing
        // `ClrType.IsEnum` directly; a throw means "definitely not an enum",
        // so IsUnsignedOrChar correctly falls through to its signed default.
        var underlying = type.ClrType.GetEnumUnderlyingTypeSafe();
        if (underlying != null)
        {
            var underlyingName = underlying.FullName;
            return underlyingName == "System.Byte"
                || underlyingName == "System.UInt16"
                || underlyingName == "System.UInt32"
                || underlyingName == "System.UInt64";
        }

        return false;
    }

    /// <summary>
    /// Returns <c>true</c> when <paramref name="type"/> represents an enum
    /// type — either a user-defined <see cref="EnumSymbol"/> or an imported
    /// CLR enum (<see cref="ImportedTypeSymbol"/> whose <see cref="TypeSymbol.ClrType"/>
    /// is an enum). Single source of truth, replacing the duplicated private
    /// IsEnumType in BoundBinaryOperator.cs and BoundUnaryOperator.cs.
    /// </summary>
    /// <param name="type">The type to check.</param>
    /// <returns><c>true</c> if the type is an enum.</returns>
    public static bool IsEnumType(TypeSymbol type)
    {
        if (type is NullableTypeSymbol)
        {
            return false;
        }

        if (type is EnumSymbol)
        {
            return true;
        }

        // Issue #2327: guard against NotSupportedException from a
        // TypeBuilderInstantiation-backed ClrType (see IsUnsignedEnumUnderlying
        // above for the full rationale).
        return type?.ClrType.IsEnumSafe() == true;
    }

    /// <summary>
    /// Gets the G# <see cref="TypeSymbol"/> representing the CLR underlying
    /// primitive type for a given enum type. Returns <c>null</c> if the type
    /// is not an enum.
    /// </summary>
    /// <param name="enumType">The enum type symbol.</param>
    /// <returns>The underlying primitive type symbol, or <c>null</c>.</returns>
    internal static TypeSymbol GetUnderlyingType(TypeSymbol enumType)
    {
        if (enumType is EnumSymbol es)
        {
            return es.UnderlyingType;
        }

        // Issue #2327: guard against NotSupportedException from a
        // TypeBuilderInstantiation-backed ClrType (see IsUnsignedEnumUnderlying
        // above for the full rationale).
        var clrUnderlying = enumType?.ClrType.GetEnumUnderlyingTypeSafe();
        if (clrUnderlying != null)
        {
            return TypeSymbol.FromClrType(clrUnderlying);
        }

        return null;
    }

    private static bool TryMatchBinaryShape(
        OperandShape shape,
        TypeSymbol leftType,
        TypeSymbol rightType,
        out TypeSymbol enumType,
        out TypeSymbol underlyingType)
    {
        enumType = null;
        underlyingType = null;

        switch (shape)
        {
            case OperandShape.EnumEnum:
                if (leftType == rightType && IsEnumType(leftType))
                {
                    enumType = leftType;
                    underlyingType = GetUnderlyingType(leftType);
                    return underlyingType != null;
                }

                return false;

            case OperandShape.EnumUnderlying:
                if (IsEnumType(leftType))
                {
                    var underlying = GetUnderlyingType(leftType);
                    if (underlying != null && underlying == rightType)
                    {
                        enumType = leftType;
                        underlyingType = underlying;
                        return true;
                    }
                }

                return false;

            case OperandShape.UnderlyingEnum:
                if (IsEnumType(rightType))
                {
                    var underlying = GetUnderlyingType(rightType);
                    if (underlying != null && underlying == leftType)
                    {
                        enumType = rightType;
                        underlyingType = underlying;
                        return true;
                    }
                }

                return false;

            default:
                return false;
        }
    }

    private readonly struct BinaryRule
    {
        public BinaryRule(BoundBinaryOperatorKind kind, OperandShape shape, ResultRule result)
        {
            Kind = kind;
            Shape = shape;
            Result = result;
        }

        public BoundBinaryOperatorKind Kind { get; }

        public OperandShape Shape { get; }

        public ResultRule Result { get; }
    }
}
