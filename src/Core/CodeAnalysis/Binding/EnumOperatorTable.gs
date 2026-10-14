// <copyright file="EnumOperatorTable.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Diagnostics.CodeAnalysis

/// Single declarative source for every C# §11.10 enum operator rule.
/// Adding a new operator group is a one-row change in this table — no new arm
/// in BoundBinaryOperator.cs or BoundUnaryOperator.cs.
/// @remarks Issues #534 (bitwise), #574 (comparison), and bug-overview item 6.6
/// (architectural unification + §11.10 arithmetic gaps) are all serviced
/// through this table. The emit-side signed-vs-unsigned dispatch
/// ((cref:IsUnsignedEnumUnderlying)) is also co-located here so the
/// connection between "binder accepted enum1 < enum2" and "emitter chose
/// clt_un" lives in one place.
///
/// <strong>Why this pattern is NOT extended to user-defined operators
/// (issue #613 investigation):</strong> The `EnumOperatorTable` is a
/// closed-world static ruleset — all enums share the same §11.10 operator set,
/// so a declarative dictionary is ideal. User-defined operators (Streams C
/// and D) are open-world dynamic dispatch: each type declares its own operator
/// set via CLR `op_*` methods or GSharp receiver-form `operator`
/// declarations. They resolve through method lookup (reflection for imported
/// CLR types in (cref:ClrOperatorResolution); symbol-table lookup for
/// GSharp types via `StructSymbol.TryGetMethodIncludingInherited`), not
/// through type-shape predicate matching. Both paths are already centralized
/// at single call sites in `ExpressionBinder.Operators.cs` and produce
/// different bound node types (`BoundCallExpression` /
/// `BoundClrBinaryOperatorExpression`) than the built-in operators this
/// table feeds. A shared base class or generic `OperatorLiftTable` would
/// add abstraction without reducing duplication, since no duplication exists
/// to consolidate.
internal shared class EnumOperatorTable {
    private enum OperandShape {
        EnumEnum,
        EnumUnderlying,
        UnderlyingEnum
    }

    private enum ResultRule {
        ResultEnum,
        ResultUnderlying,
        ResultBool
    }

    private struct BinaryRule {
        init(kind BoundBinaryOperatorKind, shape OperandShape, result ResultRule) {
            Kind = kind
            Shape = shape
            Result = result
        }

        prop Kind BoundBinaryOperatorKind {
            get;
        }

        prop Shape OperandShape {
            get;
        }

        prop Result ResultRule {
            get;
        }
    }

    private let BinaryRules Dictionary[SyntaxKind, []BinaryRule] = Dictionary[SyntaxKind, []BinaryRule]{
        [SyntaxKind.EqualsEqualsToken] = []BinaryRule{
            BinaryRule(BoundBinaryOperatorKind.Equals, OperandShape.EnumEnum, ResultRule.ResultBool)
        },
        [SyntaxKind.BangEqualsToken] = []BinaryRule{
            BinaryRule(BoundBinaryOperatorKind.NotEquals, OperandShape.EnumEnum, ResultRule.ResultBool)
        },
        [SyntaxKind.LessToken] = []BinaryRule{
            BinaryRule(BoundBinaryOperatorKind.Less, OperandShape.EnumEnum, ResultRule.ResultBool)
        },
        [SyntaxKind.LessOrEqualsToken] = []BinaryRule{
            BinaryRule(BoundBinaryOperatorKind.LessOrEquals, OperandShape.EnumEnum, ResultRule.ResultBool)
        },
        [SyntaxKind.GreaterToken] = []BinaryRule{
            BinaryRule(BoundBinaryOperatorKind.Greater, OperandShape.EnumEnum, ResultRule.ResultBool)
        },
        [SyntaxKind.GreaterOrEqualsToken] = []BinaryRule{
            BinaryRule(BoundBinaryOperatorKind.GreaterOrEquals, OperandShape.EnumEnum, ResultRule.ResultBool)
        },
        [SyntaxKind.PipeToken] = []BinaryRule{
            BinaryRule(BoundBinaryOperatorKind.BitwiseOr, OperandShape.EnumEnum, ResultRule.ResultEnum)
        },
        [SyntaxKind.AmpersandToken] = []BinaryRule{
            BinaryRule(BoundBinaryOperatorKind.BitwiseAnd, OperandShape.EnumEnum, ResultRule.ResultEnum)
        },
        [SyntaxKind.HatToken] = []BinaryRule{
            BinaryRule(BoundBinaryOperatorKind.BitwiseXor, OperandShape.EnumEnum, ResultRule.ResultEnum)
        },
        [SyntaxKind.PlusToken] = []BinaryRule{
            BinaryRule(BoundBinaryOperatorKind.Sum, OperandShape.EnumUnderlying, ResultRule.ResultEnum),
            BinaryRule(BoundBinaryOperatorKind.Sum, OperandShape.UnderlyingEnum, ResultRule.ResultEnum)
        },
        [SyntaxKind.MinusToken] = []BinaryRule{
            BinaryRule(BoundBinaryOperatorKind.Difference, OperandShape.EnumUnderlying, ResultRule.ResultEnum),
            BinaryRule(BoundBinaryOperatorKind.Difference, OperandShape.EnumEnum, ResultRule.ResultUnderlying)
        }
    }

    /// Attempts to bind a binary operator for enum operands per C# §11.10.
    /// @param syntaxKind The binary operator token kind.
    /// @param leftType The left operand type.
    /// @param rightType The right operand type.
    /// @param kind The resulting bound operator kind, if matched.
    /// @param resultType The resulting type symbol, if matched.
    /// @returns `true` if the table contains a matching rule.
    func TryBindBinary(
        syntaxKind SyntaxKind,
        leftType TypeSymbol?,
        rightType TypeSymbol?,
        out kind BoundBinaryOperatorKind,
        @NotNullWhen(true) out resultType TypeSymbol?
    ) bool {
        kind = default(BoundBinaryOperatorKind)
        resultType = nil
        if leftType == nil || rightType == nil {
            return false
        }
        if !BinaryRules.TryGetValue(syntaxKind, out var rules) {
            return false
        }
        for rule in rules {
            if TryMatchBinaryShape(rule.Shape, leftType, rightType, out var enumType, out var underlyingType) {
                kind = rule.Kind
                resultType = switch rule.Result {
                    case ResultRule.ResultBool: TypeSymbol.Bool
                    case ResultRule.ResultEnum: enumType
                    case ResultRule.ResultUnderlying: underlyingType
                    default: throw InvalidOperationException("Unknown result rule: ${rule.Result}")
                }
                return resultType != nil
            }
        }
        return false
    }

    /// Attempts to bind a unary operator for an enum operand per C# §11.10.
    /// Currently only ones-complement (~) is supported; unary minus is
    /// intentionally excluded per §11.10.
    /// @param syntaxKind The unary operator token kind.
    /// @param operandType The operand type.
    /// @param kind The resulting bound operator kind, if matched.
    /// @param resultType The resulting type symbol, if matched.
    /// @returns `true` if the table contains a matching rule.
    func TryBindUnary(
        syntaxKind SyntaxKind,
        operandType TypeSymbol?,
        out kind BoundUnaryOperatorKind,
        @NotNullWhen(true) out resultType TypeSymbol?
    ) bool {
        kind = default(BoundUnaryOperatorKind)
        resultType = nil
        if syntaxKind == SyntaxKind.TildeToken && IsEnumType(operandType) {
            kind = BoundUnaryOperatorKind.OnesComplement
            resultType = operandType
            return resultType != nil
        }
        return false
    }

    /// Returns `true` when the given type is an enum with an unsigned
    /// CLR underlying type (byte, ushort, uint, ulong). Used by the emitter's
    /// `IsUnsignedOrChar` for signed-vs-unsigned IL opcode selection.
    /// @param type The type to check.
    /// @returns `true` if [`type`](paramref) is an enum with an unsigned underlying type.
    func IsUnsignedEnumUnderlying(type TypeSymbol?) bool {
        if type == nil {
            return false
        }
        if type is EnumSymbol {
            return false
        }
        // Issue #2327: `type.ClrType` may be a
        // System.Reflection.Emit.TypeBuilderInstantiation — e.g. a
        // compiler-synthesized structural function-type delegate closed
        // over an in-flight TypeBuilder definition — whose `IsEnum` throws
        // NotSupportedException. Route through the shared safe helper
        // (generalizing the #1100/#2135 pattern) instead of probing
        // `ClrType.IsEnum` directly; a throw means "definitely not an enum",
        // so IsUnsignedOrChar correctly falls through to its signed default.
        let underlying Type? = if type.ClrType is {} clrType {
            clrType.GetEnumUnderlyingTypeSafe()
        } else {
            default(Type?)
        }
        if underlying != nil {
            let underlyingName = underlying.FullName
            return underlyingName == "System.Byte" ||
                underlyingName == "System.UInt16" ||
                underlyingName == "System.UInt32" ||
                underlyingName == "System.UInt64"
        }
        return false
    }

    /// Returns `true` when [`type`](paramref) represents an enum
    /// type — either a user-defined (cref:EnumSymbol) or an imported
    /// CLR enum ((cref:ImportedTypeSymbol) whose (cref:TypeSymbol.ClrType)
    /// is an enum). Single source of truth, replacing the duplicated private
    /// IsEnumType in BoundBinaryOperator.cs and BoundUnaryOperator.cs.
    /// @param type The type to check.
    /// @returns `true` if the type is an enum.
    func IsEnumType(type TypeSymbol?) bool {
        if type is NullableTypeSymbol {
            return false
        }
        if type is EnumSymbol {
            return true
        }
        // Issue #2327: guard against NotSupportedException from a
        // TypeBuilderInstantiation-backed ClrType (see IsUnsignedEnumUnderlying
        // above for the full rationale).
        return type?.ClrType is {} clrType && clrType.IsEnumSafe()
    }

    /// Gets the G# (cref:TypeSymbol) representing the CLR underlying
    /// primitive type for a given enum type. Returns `null` if the type
    /// is not an enum.
    /// @param enumType The enum type symbol.
    /// @returns The underlying primitive type symbol, or `null`.
    internal func GetUnderlyingType(enumType TypeSymbol?) TypeSymbol? {
        if enumType is EnumSymbol es {
            return es.UnderlyingType
        }
        // Issue #2327: guard against NotSupportedException from a
        // TypeBuilderInstantiation-backed ClrType (see IsUnsignedEnumUnderlying
        // above for the full rationale).
        let clrUnderlying Type? = if enumType?.ClrType is {} clrType {
            clrType.GetEnumUnderlyingTypeSafe()
        } else {
            default(Type?)
        }
        if clrUnderlying != nil {
            return TypeSymbol.FromClrTypeWithoutNullability(clrUnderlying, NullabilityFreeReason.TypeStructure)
        }
        return nil
    }

    private func TryMatchBinaryShape(
        shape OperandShape,
        leftType TypeSymbol,
        rightType TypeSymbol,
        out enumType TypeSymbol?,
        out underlyingType TypeSymbol?
    ) bool {
        enumType = nil
        underlyingType = nil
        switch shape {
            case OperandShape.EnumEnum {
                if leftType == rightType && IsEnumType(leftType) {
                    enumType = leftType
                    underlyingType = GetUnderlyingType(leftType)
                    return underlyingType != nil
                }
                return false
            }
            case OperandShape.EnumUnderlying {
                if IsEnumType(leftType) {
                    let underlying TypeSymbol? = GetUnderlyingType(leftType)
                    if underlying != nil && underlying == rightType {
                        enumType = leftType
                        underlyingType = underlying
                        return true
                    }
                }
                return false
            }
            case OperandShape.UnderlyingEnum {
                if IsEnumType(rightType) {
                    let underlying TypeSymbol? = GetUnderlyingType(rightType)
                    if underlying != nil && underlying == leftType {
                        enumType = rightType
                        underlyingType = underlying
                        return true
                    }
                }
                return false
            }
            default {
                return false
            }
        }
    }
}
