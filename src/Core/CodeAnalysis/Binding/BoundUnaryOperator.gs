// <copyright file="BoundUnaryOperator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic

/// Bound unary operator.
data class BoundUnaryOperator : IEquatable[BoundUnaryOperator] {
    private convenience init(syntaxKind SyntaxKind, kind BoundUnaryOperatorKind, operandType TypeSymbol) {
        init(syntaxKind, kind, operandType, operandType)
    }

    private init(syntaxKind SyntaxKind, kind BoundUnaryOperatorKind, operandType TypeSymbol, resultType TypeSymbol) {
        SyntaxKind = syntaxKind
        Kind = kind
        OperandType = operandType
        Type = resultType
    }

    /// Gets the syntax kind.
    prop SyntaxKind SyntaxKind {
        get;
    }

    /// Gets the operator kind.
    prop Kind BoundUnaryOperatorKind {
        get;
    }

    /// Gets the operand type.
    prop OperandType TypeSymbol {
        get;
    }

    /// Gets the type symbol type.
    prop Type TypeSymbol {
        get;
    }

    shared {
        private var supportedOperators[]BoundUnaryOperator = BuildSupportedOperators()

        /// Binds a syntax kind and a type symbol to the corresponding bound unary operator, or
        /// null if the syntax kind isn't a unary operator, or is not a supported unary operator.
        /// @param syntaxKind The syntax kind.
        /// @param operandType The type symbol.
        /// @returns A bound unary operator.
        func Bind(syntaxKind SyntaxKind, operandType TypeSymbol) BoundUnaryOperator? {
            // Phase 3.C.3 / ADR-0001: postfix `!!` is dynamically typed by the
            // operand: it returns the underlying type when applied to T?, and is
            // a no-op on already-non-nullable values (binder will diagnose).
            //
            // Issue #614 audit: intentionally a single arm — there is only ONE
            // null-assertion operator token, and the result type is computed from
            // the operand type at runtime. No combinatorial dimension to tabulate.
            if syntaxKind == SyntaxKind.BangBangToken {
                // ADR-0186 §6: `!!` on a `T!` yields `T` and emits the check. It is
                // legal and it is NOT redundant — it is the explicit spelling of
                // the very conversion §4 would otherwise perform implicitly at the
                // same point, which is what keeps every existing `!!` in the
                // migrated corpus compiling and meaning precisely what it means
                // today.
                let underlying = switch operandType {
                    case n is NullableTypeSymbol: n.UnderlyingType
                    case p is PlatformTypeSymbol: p.UnderlyingType
                    default: operandType
                }
                return BoundUnaryOperator(syntaxKind, BoundUnaryOperatorKind.NullAssertion, operandType, underlying)
            }
            // Issue #2544: predefined unary operators lift from T to T? when T is
            // a value type. Resolve the underlying operation first so invalid
            // combinations (for example, +bool? or !int32?) still fail normally.
            if operandType is NullableTypeSymbol nullable && nullable.UnderlyingType?.ClrType is {IsValueType: true} {
                let underlyingOperator BoundUnaryOperator? = Bind(syntaxKind, nullable.UnderlyingType)
                if underlyingOperator != nil {
                    return BoundUnaryOperator(
                        syntaxKind,
                        underlyingOperator.Kind,
                        operandType,
                        NullableTypeSymbol.Get(underlyingOperator.Type)
                    )
                }
            }
            for op in supportedOperators {
                if op.SyntaxKind == syntaxKind && op.OperandType == operandType {
                    return op
                }
            }
            // Issues #534 and 6.6 unification: ^ (ones complement) on enum
            // values drives through the EnumOperatorTable.
            if EnumOperatorTable.TryBindUnary(syntaxKind, operandType, out var enumKind, out var enumResultType) {
                return BoundUnaryOperator(syntaxKind, enumKind, operandType, enumResultType)
            }
            return nil
        }

        private func BuildSupportedOperators()[]BoundUnaryOperator {
            let list = List[BoundUnaryOperator]{
                BoundUnaryOperator(SyntaxKind.BangToken, BoundUnaryOperatorKind.LogicalNegation, TypeSymbol.Bool)
            }
            // ADR-0044: unary +, -, ~ on every signed integral primitive.
            let signed[]TypeSymbol = []TypeSymbol{
                TypeSymbol.Int8,
                TypeSymbol.Int16,
                TypeSymbol.Int32,
                TypeSymbol.Int64,
                TypeSymbol.NInt
            }
            for t in signed {
                list.Add(BoundUnaryOperator(SyntaxKind.PlusToken, BoundUnaryOperatorKind.Identity, t))
                list.Add(BoundUnaryOperator(SyntaxKind.MinusToken, BoundUnaryOperatorKind.Negation, t))
                list.Add(BoundUnaryOperator(SyntaxKind.TildeToken, BoundUnaryOperatorKind.OnesComplement, t))
            }
            // Unsigned integrals: unary + and ~ only (C# does not define unary
            // minus on unsigned types directly; users can cast first).
            let unsigned[]TypeSymbol = []TypeSymbol{
                TypeSymbol.UInt8,
                TypeSymbol.UInt16,
                TypeSymbol.UInt32,
                TypeSymbol.UInt64,
                TypeSymbol.NUInt
            }
            for t in unsigned {
                list.Add(BoundUnaryOperator(SyntaxKind.PlusToken, BoundUnaryOperatorKind.Identity, t))
                list.Add(BoundUnaryOperator(SyntaxKind.TildeToken, BoundUnaryOperatorKind.OnesComplement, t))
            }
            // char: unary + only (treat as identity); ~ and - require explicit promotion.
            list.Add(BoundUnaryOperator(SyntaxKind.PlusToken, BoundUnaryOperatorKind.Identity, TypeSymbol.Char))
            // Floating-point + decimal: unary + and -.
            let floats[]TypeSymbol = []TypeSymbol{TypeSymbol.Float32, TypeSymbol.Float64, TypeSymbol.Decimal}
            for t in floats {
                list.Add(BoundUnaryOperator(SyntaxKind.PlusToken, BoundUnaryOperatorKind.Identity, t))
                list.Add(BoundUnaryOperator(SyntaxKind.MinusToken, BoundUnaryOperatorKind.Negation, t))
            }
            return list.ToArray()
        }
    }
}
